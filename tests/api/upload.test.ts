import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as pipeline from "@/lib/image/pipeline";
import { getDb } from "@/lib/db/client";
import { getExhibition, bumpInputRevision } from "@/lib/db/repos";
import { insertPhotoAsset, listPhotos } from "@/lib/db/photos";
import { startPipeline, isRunning } from "@/lib/orchestrator/orchestrator";
import { runIngest } from "@/lib/agents/materialSteward";
import { uploadsDir } from "@/lib/files";
import { newId } from "@/lib/id";

vi.mock("@/lib/agents/materialSteward", () => ({ runIngest: vi.fn(async () => ({})) }));
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createDb } from "@/lib/db/client";
import { createExhibition } from "@/lib/db/repos";
import { countPhotos } from "@/lib/db/photos";
import { CreateExhibitionInput } from "@/lib/agents/schemas";
import { POST as uploadPhotos, GET as getPhotos } from "@/app/api/exhibitions/[id]/photos/route";
import { GET as getFile } from "@/app/api/files/[exhId]/[photoId]/route";

const SVG = `<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#2a4a7a"/><stop offset="1" stop-color="#a8c0d8"/></linearGradient></defs>
  <rect width="200" height="200" fill="url(#g)"/>
  <circle cx="60" cy="50" r="28" fill="#f0e0b0"/></svg>`;

let tmp: string;
let exhId: string;
let goodJpeg: Buffer;

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

const part = (b: Buffer) => new Uint8Array(b);

async function upload(files: File[], id = exhId) {
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  const req = new Request(`http://localhost/api/exhibitions/${exhId}/photos`, {
    method: "POST",
    body: fd,
  });
  const res = await uploadPhotos(req, ctx(id));
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-upload-"));
  process.env.AFTERLIGHT_DATA_DIR = tmp;
  // 注入全局 DB 单例，使路由内部的 getDb() 命中测试库。
  (globalThis as unknown as { __afterlightDb?: unknown }).__afterlightDb = createDb(":memory:");
  const { getDb } = await import("@/lib/db/client");
  exhId = createExhibition(getDb(), CreateExhibitionInput.parse({}), "demo").id;
  goodJpeg = await sharp(Buffer.from(SVG)).jpeg().toBuffer();
});

afterAll(() => {
  delete (globalThis as unknown as { __afterlightDb?: unknown }).__afterlightDb;
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.AFTERLIGHT_DATA_DIR;
});

function pauseUpload() {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const real = pipeline.prepareUpload;
  const spy = vi.spyOn(pipeline, "prepareUpload").mockImplementationOnce(async (buf) => {
    entered.resolve();
    await resume.promise;
    return real(buf);
  });
  return { entered: entered.promise, resume: () => resume.resolve(), spy };
}

function photoFile(name = "race.jpg") {
  return new File([part(goodJpeg)], name, { type: "image/jpeg" });
}

function seedRows(id: string, count: number) {
  for (let i = 0; i < count; i++) {
    insertPhotoAsset(getDb(), {
      id: newId("photo"), exhibition_id: id, original_name: "seed.jpg",
      storage_path: "synthetic.jpg", thumbnail_path: "synthetic-thumb.jpg",
      width: 200, height: 200, mime_type: "image/jpeg", file_size: 1,
      sha256: "synthetic", sort_order: i,
    });
  }
}

describe("S07/S08 upload commit races", () => {
  it("慢上传期间启动 run：拒绝提交，只清本次文件，revision 不变", async () => {
    const id = createExhibition(getDb(), CreateExhibitionInput.parse({}), "demo").id;
    await upload([photoFile("existing.jpg")], id);
    const beforeFiles = fs.readdirSync(uploadsDir(id)).sort();
    const before = getExhibition(getDb(), id)!;
    const gate = pauseUpload();
    const runGate = Promise.withResolvers<void>();
    const pending = upload([photoFile()], id);
    await gate.entered;
    vi.mocked(runIngest).mockImplementationOnce(async () => { await runGate.promise; return {} as never; });
    startPipeline(getDb(), id, "ingest", "ingest");
    gate.resume();
    try {
      const res = await pending;
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("concurrent_run");
      expect(countPhotos(getDb(), id)).toBe(1);
      expect(getExhibition(getDb(), id)!.input_revision).toBe(before.input_revision);
      expect(fs.readdirSync(uploadsDir(id)).sort()).toEqual(beforeFiles);
    } finally {
      gate.spy.mockRestore();
      runGate.resolve();
      await vi.waitFor(() => expect(isRunning(getDb(), id)).toBe(false));
    }
  });

  it("59 张时两个上传交错：最终 60 张，输家不删除赢家文件", async () => {
    const id = createExhibition(getDb(), CreateExhibitionInput.parse({}), "demo").id;
    seedRows(id, 59);
    const gate = pauseUpload();
    const slow = upload([photoFile("slow.jpg")], id);
    await gate.entered;
    const winner = await upload([photoFile("winner.jpg")], id);
    const winnerFiles = fs.readdirSync(uploadsDir(id)).sort();
    gate.resume();
    try {
      const loser = await slow;
      expect(winner.status).toBe(201);
      expect(loser.status).toBe(400);
      expect(loser.body.error.code).toBe("too_many_photos");
      expect(countPhotos(getDb(), id)).toBe(60);
      expect(getExhibition(getDb(), id)!.input_revision).toBe(1);
      expect(fs.readdirSync(uploadsDir(id)).sort()).toEqual(winnerFiles);
    } finally { gate.spy.mockRestore(); }
  });

  it("输入修订在处理期间变化：拒绝旧上传", async () => {
    const id = createExhibition(getDb(), CreateExhibitionInput.parse({}), "demo").id;
    const gate = pauseUpload();
    const pending = upload([photoFile()], id);
    await gate.entered;
    bumpInputRevision(getDb(), id);
    gate.resume();
    try {
      const res = await pending;
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("stale_input");
      expect(countPhotos(getDb(), id)).toBe(0);
      expect(fs.readdirSync(uploadsDir(id))).toEqual([]);
    } finally { gate.spy.mockRestore(); }
  });

  it("59 张加一好一坏：只有成功 staged 文件占名额", async () => {
    const id = createExhibition(getDb(), CreateExhibitionInput.parse({}), "demo").id;
    seedRows(id, 59);
    const res = await upload([photoFile(), new File(["broken"], "bad.jpg", { type: "image/jpeg" })], id);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ uploaded: 1, failed: 1 });
    expect(countPhotos(getDb(), id)).toBe(60);
  });

  it("BEGIN 失败也清本次写盘，不清已有照片", async () => {
    const id = createExhibition(getDb(), CreateExhibitionInput.parse({}), "demo").id;
    await upload([photoFile("existing.jpg")], id);
    const before = fs.readdirSync(uploadsDir(id)).sort();
    const gate = pauseUpload();
    const pending = upload([photoFile()], id);
    await gate.entered;
    const realExec = getDb().exec.bind(getDb());
    const exec = vi.spyOn(getDb(), "exec").mockImplementation((sql) => {
      if (/^BEGIN/.test(sql)) throw new Error("simulated busy");
      return realExec(sql);
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    gate.resume();
    try {
      expect((await pending).status).toBe(500);
      expect(fs.readdirSync(uploadsDir(id)).sort()).toEqual(before);
      expect(countPhotos(getDb(), id)).toBe(1);
    } finally { gate.spy.mockRestore(); exec.mockRestore(); log.mockRestore(); }
  });

  it("提交时按最新 sort_order 尾部追加，而不是旧 count", async () => {
    const id = createExhibition(getDb(), CreateExhibitionInput.parse({}), "demo").id;
    seedRows(id, 1);
    const gate = pauseUpload();
    const pending = upload([photoFile()], id);
    await gate.entered;
    getDb().prepare("UPDATE photo_assets SET sort_order=99 WHERE exhibition_id=?").run(id);
    gate.resume();
    try {
      expect((await pending).status).toBe(201);
      expect(listPhotos(getDb(), id).map((p) => p.sort_order)).toEqual([99, 100]);
    } finally { gate.spy.mockRestore(); }
  });
});

describe("upload API (§17.1)", () => {
  it("正常上传返回缩略图 URL 与尺寸", async () => {
    const file = new File([part(goodJpeg)], "photo.jpg", { type: "image/jpeg" });
    const { status, body } = await upload([file]);
    expect(status).toBe(201);
    expect(body.uploaded).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.photos[0].status).toBe("uploaded");
    expect(body.photos[0].thumbnail_url).toContain("?variant=thumb");
    expect(body.photos[0].width).toBe(200);
  });

  it("超过 25MB 被拒（真实照片实测 9.8–14.5MB 后放宽，边界同步上调）", async () => {
    const big = new File([part(Buffer.alloc(26 * 1024 * 1024))], "big.jpg", { type: "image/jpeg" });
    const { body } = await upload([big]);
    expect(body.uploaded).toBe(0);
    expect(body.photos[0].status).toBe("rejected");
    expect(body.photos[0].error).toContain("25MB");
  });

  it(".gif 不在白名单被拒", async () => {
    const gif = new File([part(goodJpeg)], "anim.gif", { type: "image/gif" });
    const { body } = await upload([gif]);
    expect(body.uploaded).toBe(0);
    expect(body.photos[0].status).toBe("rejected");
    expect(body.photos[0].error).toContain("JPG");
  });

  it("三文件中一坏 → 两成功（逐文件隔离）", async () => {
    const a = new File([part(goodJpeg)], "a.jpg", { type: "image/jpeg" });
    const bad = new File([part(Buffer.from("not an image at all"))], "bad.jpg", { type: "image/jpeg" });
    const b = new File([part(goodJpeg)], "b.jpg", { type: "image/jpeg" });
    const { body } = await upload([a, bad, b]);
    expect(body.uploaded).toBe(2);
    expect(body.failed).toBe(1);
    const statuses = body.photos.map((p: { status: string }) => p.status);
    expect(statuses).toEqual(["uploaded", "failed", "uploaded"]);
    expect(body.photos[1].error).toBeTruthy();
  });

  it("GET 列出照片，files 路由可取缩略图", async () => {
    const res = await getPhotos(new Request("http://localhost/x"), ctx(exhId));
    const { photos } = await res.json();
    expect(photos.length).toBe(countPhotos((await import("@/lib/db/client")).getDb(), exhId));
    const uploaded = photos.find((p: { status: string }) => p.status === "uploaded");
    expect(uploaded).toBeTruthy();

    const fileRes = await getFile(
      new Request(`http://localhost/api/files/${exhId}/${uploaded.id}?variant=thumb`),
      { params: Promise.resolve({ exhId, photoId: uploaded.id }) },
    );
    expect(fileRes.status).toBe(200);
    expect(fileRes.headers.get("content-type")).toBe("image/jpeg");
    expect((await fileRes.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });
});
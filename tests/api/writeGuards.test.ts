import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createDb, getDb } from "@/lib/db/client";
import { createExhibition, getExhibition, updateExhibition } from "@/lib/db/repos";
import { insertPhotoAsset, countPhotos } from "@/lib/db/photos";
import { replaceNarrative, getNarrative } from "@/lib/db/narrative";
import { createRun } from "@/lib/db/runs";
import { CreateExhibitionInput, NarrativePlan } from "@/lib/agents/schemas";
import { POST as uploadPhotos, GET as getPhotos } from "@/app/api/exhibitions/[id]/photos/route";
import { PATCH as patchNarrative } from "@/app/api/exhibitions/[id]/narrative/route";
import { newId } from "@/lib/id";
import type { DatabaseSync } from "node:sqlite";

let tmp: string;
let db: DatabaseSync;
let goodJpeg: Buffer;

const SVG = `<svg width="160" height="120" xmlns="http://www.w3.org/2000/svg">
  <rect width="160" height="120" fill="#355a7a"/><circle cx="50" cy="40" r="20" fill="#f0e0b0"/></svg>`;

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function upload(exhId: string, files: File[]) {
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  const req = new Request(`http://localhost/api/exhibitions/${exhId}/photos`, { method: "POST", body: fd });
  const res = await uploadPhotos(req, ctx(exhId));
  return { status: res.status, body: await res.json() };
}

function photoFile(name = "p.jpg"): File {
  return new File([new Uint8Array(goodJpeg)], name, { type: "image/jpeg" });
}

function fakePhotos(exhId: string, n: number) {
  for (let i = 0; i < n; i++) {
    insertPhotoAsset(db, {
      id: newId("photo"), exhibition_id: exhId, original_name: `old${i}.jpg`,
      storage_path: `uploads/${exhId}/old${i}.jpg`, thumbnail_path: null,
      width: 10, height: 10, mime_type: "image/jpeg", file_size: 10,
      sha256: newId("sha"), sort_order: i,
    });
  }
}

function runningRun(exhId: string): void {
  createRun(db, {
    exhibitionId: exhId, agentType: "material_steward", status: "running",
    inputVersion: 0, workflowId: "wf_guard", inputRevision: 0,
  });
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-guards-"));
  process.env.AFTERLIGHT_DATA_DIR = tmp;
  (globalThis as unknown as { __afterlightDb?: unknown }).__afterlightDb = createDb(":memory:");
  db = getDb();
  goodJpeg = await sharp(Buffer.from(SVG)).jpeg().toBuffer();
});

afterAll(() => {
  delete (globalThis as unknown as { __afterlightDb?: unknown }).__afterlightDb;
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.AFTERLIGHT_DATA_DIR;
});

describe("R07 上传推进版本与失效", () => {
  it("新增照片：input_revision+1、确认失效、从 ingest 标记过期", async () => {
    const exhId = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    updateExhibition(db, exhId, {
      status: "awaiting_user_review",
      selection_confirmed_revision: 7,
      selection_confirmed_photo_ids: JSON.stringify([]),
      selection_hold_policy: "exclude",
    });
    const before = getExhibition(db, exhId)!.input_revision;

    const { status, body } = await upload(exhId, [photoFile()]);
    expect(status).toBe(201);
    expect(body.uploaded).toBe(1);

    const after = getExhibition(db, exhId)!;
    expect(after.input_revision).toBe(before + 1);
    expect(after.selection_confirmed_revision).toBeNull();
    expect(after.selection_confirmed_photo_ids).toBeNull();
    expect(after.stale_from).toBe("ingest");
    expect(after.status).toBe("awaiting_user_review");
  });

  it("被拒/坏文件不占 60 张名额（只按有效候选计数）", async () => {
    const exhId = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    fakePhotos(exhId, 59);
    const gif = new File([new Uint8Array(goodJpeg)], "x.gif", { type: "image/gif" });
    const { status, body } = await upload(exhId, [gif, photoFile()]);
    expect(status).toBe(201);
    expect(body.uploaded).toBe(1);
    expect(body.photos[0].status).toBe("rejected");
    expect(countPhotos(db, exhId)).toBe(60);
  });
});

describe("R07 活跃生成期间拒绝输入写操作", () => {
  it("上传被拒（409 concurrent_run），不新增照片", async () => {
    const exhId = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    runningRun(exhId);
    const before = countPhotos(db, exhId);
    const { status, body } = await upload(exhId, [photoFile()]);
    expect(status).toBe(409);
    expect(body.error.code).toBe("concurrent_run");
    expect(countPhotos(db, exhId)).toBe(before);
  });

  it("叙事编辑被拒，草稿数据保持原样；读取仍可用", async () => {
    const exhId = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    const pid = newId("photo");
    insertPhotoAsset(db, {
      id: pid, exhibition_id: exhId, original_name: "a.jpg", storage_path: "uploads/x/a.jpg",
      thumbnail_path: null, width: 10, height: 10, mime_type: "image/jpeg", file_size: 10,
      sha256: newId("sha"), sort_order: 0,
    });
    replaceNarrative(db, exhId, NarrativePlan.parse({
      title: "原标题", subtitle: "", curatorial_statement: "原策展语。",
      chapters: [
        { id: "chapter_01", title: "一", description: "一。", photo_ids: [pid] },
        { id: "chapter_02", title: "二", description: "二。", photo_ids: [pid] },
      ],
      tone: "restrained",
    }), { source: "heuristic", inputVersion: 0 });
    runningRun(exhId);

    const patch = await patchNarrative(
      new Request("http://localhost/x", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expected_version: getExhibition(db, exhId)!.current_version,
          expected_edit_revision: getNarrative(db, exhId)!.edit_revision,
          edits: [{ target_path: "chapter:chapter_01.title", value: "新标题" }],
        }),
      }),
      ctx(exhId),
    );
    expect(patch.status).toBe(409);
    expect((await patch.json()).error.code).toBe("concurrent_run");
    expect(getNarrative(db, exhId)!.chapters[0].title).toBe("一");

    const read = await getPhotos(new Request("http://localhost/x"), ctx(exhId));
    expect(read.status).toBe(200);
  });
});

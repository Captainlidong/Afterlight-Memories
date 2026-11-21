import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb, getDb } from "@/lib/db/client";
import { createExhibition, getExhibition } from "@/lib/db/repos";
import { insertPhotoAsset, listPhotos } from "@/lib/db/photos";
import { uploadsDir, toRelative } from "@/lib/files";
import { CreateExhibitionInput } from "@/lib/agents/schemas";
import { newId } from "@/lib/id";
import { DELETE, GET } from "@/app/api/exhibitions/[id]/route";

let tmp: string;

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function seedWithFile(): string {
  const db = getDb();
  const exhId = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
  const dir = uploadsDir(exhId);
  fs.mkdirSync(dir, { recursive: true });
  const photoId = newId("photo");
  const abs = path.join(dir, `${photoId}.jpg`);
  fs.writeFileSync(abs, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  insertPhotoAsset(db, {
    id: photoId, exhibition_id: exhId, original_name: "x.jpg",
    storage_path: toRelative(abs), thumbnail_path: null,
    width: 10, height: 10, mime_type: "image/jpeg", file_size: 4,
    sha256: newId("sha"), sort_order: 0,
  });
  return exhId;
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-del-"));
  process.env.AFTERLIGHT_DATA_DIR = tmp;
  (globalThis as unknown as { __afterlightDb?: unknown }).__afterlightDb = createDb(":memory:");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("DELETE /api/exhibitions/[id]（§13.1 删除影展与所有图片）", () => {
  it("删除影展行、级联照片行，并移除本机原图目录", async () => {
    const exhId = seedWithFile();
    const dir = uploadsDir(exhId);
    expect(fs.existsSync(dir)).toBe(true);
    expect(listPhotos(getDb(), exhId)).toHaveLength(1);

    const res = await DELETE(new Request("http://localhost/x", { method: "DELETE" }), ctx(exhId) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: exhId });

    expect(getExhibition(getDb(), exhId)).toBeNull();
    expect(listPhotos(getDb(), exhId)).toHaveLength(0);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("删除后 GET 与再次 DELETE 均 404", async () => {
    const exhId = seedWithFile();
    await DELETE(new Request("http://localhost/x", { method: "DELETE" }), ctx(exhId) as never);
    const get = await GET(new Request("http://localhost/x"), ctx(exhId) as never);
    expect(get.status).toBe(404);
    const again = await DELETE(new Request("http://localhost/x", { method: "DELETE" }), ctx(exhId) as never);
    expect(again.status).toBe(404);
  });

  it("不影响其他影展的数据与文件", async () => {
    const a = seedWithFile();
    const b = seedWithFile();
    await DELETE(new Request("http://localhost/x", { method: "DELETE" }), ctx(a) as never);
    expect(getExhibition(getDb(), b)).not.toBeNull();
    expect(listPhotos(getDb(), b)).toHaveLength(1);
    expect(fs.existsSync(uploadsDir(b))).toBe(true);
  });
});
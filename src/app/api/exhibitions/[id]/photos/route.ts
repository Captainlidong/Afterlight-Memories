import fs from "node:fs";
import path from "node:path";
import { getDb } from "@/lib/db/client";
import { getExhibition, bumpInputRevision, clearConfirmation } from "@/lib/db/repos";
import {
  countPhotos,
  insertPhotoAsset,
  listPhotos,
  listInspections,
} from "@/lib/db/photos";
import { prepareUpload } from "@/lib/image/pipeline";
import { uploadsDir, toRelative } from "@/lib/files";
import { markStale } from "@/lib/orchestrator/rerunMatrix";
import { assertWritable } from "@/lib/orchestrator/guard";
import { newId } from "@/lib/id";
import { ApiError, ok, handler } from "@/lib/api/errors";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const MAX_SIZE = 25 * 1024 * 1024; // 单张 ≤25MB：作者真实照片实测 9.8–14.5MB，原 §11.2 的 10MB 会挡住正常上传；AI 分析仍用压缩副本，与原图大小无关。
const MAX_PHOTOS = 60; // §11.2 一次 ≤60 张
const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

interface UploadResult {
  id?: string;
  original_name: string;
  status: "uploaded" | "failed" | "rejected";
  error?: string;
  thumbnail_url?: string;
  width?: number;
  height?: number;
  file_size?: number;
}

export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const db = getDb();
  if (!getExhibition(db, id)) throw new ApiError(404, "not_found", "影展不存在。");
  return ok({ photos: listPhotos(db, id), inspections: listInspections(db, id) });
});

export const POST = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const db = getDb();
  const initial = getExhibition(db, id);
  if (!initial) throw new ApiError(404, "not_found", "影展不存在。");
  assertWritable(db, id);

  const form = await req.formData();
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    throw new ApiError(400, "no_files", "未收到任何文件（表单字段名应为 files）。");
  }
  // 名额只由最终成功的 staged 文件占用，在提交锁内按最新数量校验。

  const dir = uploadsDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const results: UploadResult[] = [];
  const staged: {
    photoId: string;
    name: string;
    type: string;
    size: number;
    sha256: string;
    width: number;
    height: number;
    origAbs: string;
    thumbAbs: string;
  }[] = [];
  const written: string[] = [];

  // 逐文件隔离（§11.2 / §17.1）：单个坏文件只标自身失败，不影响其余。
  for (const file of files) {
    const name = file.name || "photo";
    if (!MIME_EXT[file.type]) {
      results.push({ original_name: name, status: "rejected", error: "仅支持 JPG / PNG / WEBP。" });
      continue;
    }
    if (file.size > MAX_SIZE) {
      results.push({ original_name: name, status: "rejected", error: "单张超过 25MB 限制。" });
      continue;
    }
    let origAbs = "";
    let thumbAbs = "";
    try {
      const buf = Buffer.from(await file.arrayBuffer());
      const prepared = await prepareUpload(buf);
      const photoId = newId("photo");
      const ext = MIME_EXT[file.type];
      origAbs = path.join(dir, `${photoId}.${ext}`);
      thumbAbs = path.join(dir, `thumb_${photoId}.jpg`);
      fs.writeFileSync(origAbs, buf);
      written.push(origAbs);
      fs.writeFileSync(thumbAbs, prepared.thumbnail);
      written.push(thumbAbs);
      staged.push({
        photoId, name, type: file.type, size: buf.length,
        sha256: prepared.sha256, width: prepared.width, height: prepared.height,
        origAbs, thumbAbs,
      });
      results.push({
        id: photoId,
        original_name: name,
        status: "uploaded",
        thumbnail_url: `/api/files/${id}/${photoId}?variant=thumb`,
        width: prepared.width,
        height: prepared.height,
        file_size: buf.length,
      });
    } catch (err) {
      // 写盘/处理失败：清掉可能已落盘的单文件孤儿，不占成功数量。
      if (origAbs) fs.rmSync(origAbs, { force: true, maxRetries: 3 });
      if (thumbAbs) fs.rmSync(thumbAbs, { force: true, maxRetries: 3 });
      results.push({
        original_name: name,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 插入 + revision/确认失效/stale 同一事务：要么整批可见，要么整批回滚并清理文件。
  let uploaded = 0;
  if (staged.length > 0) {
    let transactionStarted = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      const current = getExhibition(db, id);
      if (!current) throw new ApiError(404, "not_found", "影展不存在。");
      assertWritable(db, id);
      const latestCount = countPhotos(db, id);
      if (latestCount + staged.length > MAX_PHOTOS) {
        throw new ApiError(400, "too_many_photos", `最多 ${MAX_PHOTOS} 张（当前已有 ${latestCount} 张，本次成功处理 ${staged.length} 张）。`);
      }
      if (current.input_revision !== initial.input_revision) {
        throw new ApiError(409, "stale_input", "上传处理期间素材或策展输入已变化，请重新上传。");
      }
      let order = (db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM photo_assets WHERE exhibition_id=?")
        .get(id) as { next_order: number }).next_order;
      for (const s of staged) {
        insertPhotoAsset(db, {
          id: s.photoId,
          exhibition_id: id,
          original_name: s.name,
          storage_path: toRelative(s.origAbs),
          thumbnail_path: toRelative(s.thumbAbs),
          width: s.width,
          height: s.height,
          mime_type: s.type,
          file_size: s.size,
          sha256: s.sha256,
          sort_order: order++,
        });
      }
      // 新素材未分析：推进输入版本、原选片确认失效，并从 ingest 起标记过期。
      bumpInputRevision(db, id);
      clearConfirmation(db, id);
      markStale(db, id, "ingest");
      db.exec("COMMIT");
      uploaded = staged.length;
    } catch (err) {
      try {
        if (transactionStarted && db.isTransaction) db.exec("ROLLBACK");
      } finally {
        // 包含 BEGIN 失败；只清本请求生成的随机文件，绝不清整个目录。
        for (const p of written) fs.rmSync(p, { force: true, maxRetries: 3 });
      }
      throw err;
    }
  }

  return ok({ photos: results, uploaded, failed: results.length - uploaded }, { status: 201 });
});
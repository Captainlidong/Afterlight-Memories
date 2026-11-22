import fs from "node:fs";
import { getDb } from "@/lib/db/client";
import { getExhibition, updateExhibition, bumpInputRevision } from "@/lib/db/repos";
import { getPhoto, deletePhoto, listInspections } from "@/lib/db/photos";
import { listMotifs } from "@/lib/db/motifs";
import { markStale } from "@/lib/orchestrator/rerunMatrix";
import { assertWritable } from "@/lib/orchestrator/guard";
import { toAbsolute } from "@/lib/files";
import { ApiError, ok, handler } from "@/lib/api/errors";

import { requireVisitorMutation } from "@/lib/visitor/access";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; photoId: string }> };

export const DELETE = handler(async (_req: Request, { params }: Ctx) => {
  const { id, photoId } = await params;
  const db = getDb();
  requireVisitorMutation(db, _req, id);
  const exh = getExhibition(db, id);
  if (!exh) throw new ApiError(404, "not_found", "影展不存在。");
  const photo = getPhoto(db, photoId);
  if (!photo || photo.exhibition_id !== id) {
    throw new ApiError(404, "not_found", "照片不存在。");
  }
  assertWritable(db, id);

  for (const rel of [photo.storage_path, photo.thumbnail_path]) {
    if (rel) fs.rmSync(toAbsolute(rel), { force: true, maxRetries: 3 });
  }
  deletePhoto(db, photoId); // 级联删除 photo_inspections
  bumpInputRevision(db, id);

  // 素材集变化（重跑矩阵 delete_photo → motifs→qa）；尚未产出主题时退回 ingest 起点。
  if (exh.status !== "draft" && exh.status !== "uploading" && listInspections(db, id).length > 0) {
    markStale(db, id, listMotifs(db, id).length > 0 ? "motifs" : "ingest");
  }
  // 已确认选片快照里剔除被删照片，保持快照与事实一致。
  if (exh.selection_confirmed_photo_ids?.includes(photoId)) {
    updateExhibition(db, id, {
      selection_confirmed_photo_ids: JSON.stringify(
        exh.selection_confirmed_photo_ids.filter((pid) => pid !== photoId),
      ),
    });
  }
  return ok({ deleted: photoId });
});
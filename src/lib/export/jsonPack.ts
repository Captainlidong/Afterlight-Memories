import type { DatabaseSync } from "node:sqlite";
import { getExhibition } from "../db/repos";
import { listPhotos, listInspections } from "../db/photos";
import { listDecisions } from "../db/curation";
import { listMotifs } from "../db/motifs";
import { getNarrative } from "../db/narrative";
import { getLayout } from "../db/layout";
import { getQa } from "../db/qa";
import { listEdits } from "../db/edits";
import { listVersions } from "../db/versions";
import { ApiError } from "../api/errors";

/** JSON 包（§导出）：schema_version + 全量结果 + 用户编辑 + 版本摘要。导入不在 MVP。 */
export function buildJsonPack(db: DatabaseSync, exhibitionId: string) {
  const exhibition = getExhibition(db, exhibitionId);
  if (!exhibition) throw new ApiError(404, "not_found", "影展不存在。");
  return {
    schema_version: 1,
    exported_at: new Date().toISOString(),
    exhibition,
    photos: listPhotos(db, exhibitionId),
    inspections: listInspections(db, exhibitionId),
    decisions: listDecisions(db, exhibitionId),
    motifs: listMotifs(db, exhibitionId),
    narrative: getNarrative(db, exhibitionId),
    layout: getLayout(db, exhibitionId),
    qa: getQa(db, exhibitionId),
    user_edits: listEdits(db, exhibitionId),
    versions: listVersions(db, exhibitionId),
  };
}
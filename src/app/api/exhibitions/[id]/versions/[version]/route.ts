import { getDb } from "@/lib/db/client";
import { getExhibition } from "@/lib/db/repos";
import { getNarrative } from "@/lib/db/narrative";
import { restoreVersion } from "@/lib/orchestrator/versions";
import { assertWritable } from "@/lib/orchestrator/guard";
import { ApiError, ok, handler } from "@/lib/api/errors";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; version: string }> };

/** 回滚到指定版本（§10.11 / 提示词8）。单事务全保真恢复（含编辑/锁定），再记一版。运行中禁止回滚。 */
export const POST = handler(async (_req: Request, { params }: Ctx) => {
  const { id, version } = await params;
  const db = getDb();
  if (!getExhibition(db, id)) throw new ApiError(404, "not_found", "影展不存在。");
  const v = Number(version);
  if (!Number.isInteger(v) || v < 1) {
    throw new ApiError(400, "invalid_version", "版本号必须为正整数。");
  }
  assertWritable(db, id);
  const newVersion = restoreVersion(db, id, v);
  return ok({
    version: newVersion,
    current_version: getExhibition(db, id)!.current_version,
    narrative: getNarrative(db, id),
  });
});
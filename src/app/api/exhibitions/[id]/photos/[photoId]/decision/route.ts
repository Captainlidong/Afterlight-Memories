import { getDb } from "@/lib/db/client";
import { getExhibition, bumpInputRevision } from "@/lib/db/repos";
import { getPhoto } from "@/lib/db/photos";
import { getDecision, setUserOverride } from "@/lib/db/curation";
import { invalidateForDecisionChange } from "@/lib/orchestrator/rerunMatrix";
import { assertWritable } from "@/lib/orchestrator/guard";
import { UpdateDecisionInput } from "@/lib/agents/schemas";
import { ApiError, ok, handler } from "@/lib/api/errors";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; photoId: string }> };

const inKeepSet = (d: string) => d === "keep" || d === "must_keep";

/**
 * 用户覆盖单张照片决定（§11.5 / 提示词3）。must_keep 的唯一入口。
 * 只写 user_override 列，ai_decision 保持不变；bump input_revision + 统一失效：
 * 保留集变化 → 确认失效 + motifs 过期，否则 narrative 过期（§19.5 / §5 B2）。
 */
export const PATCH = handler(async (req: Request, { params }: Ctx) => {
  const { id, photoId } = await params;
  const db = getDb();
  const exh = getExhibition(db, id);
  if (!exh) throw new ApiError(404, "not_found", "影展不存在。");
  const photo = getPhoto(db, photoId);
  if (!photo || photo.exhibition_id !== id) {
    throw new ApiError(404, "not_found", "照片不存在。");
  }
  const input = UpdateDecisionInput.parse(await req.json());
  assertWritable(db, id);
  const existing = getDecision(db, photoId);
  if (!existing) {
    throw new ApiError(409, "no_curation", "该照片还没有选片建议，请先完成推荐选片。");
  }

  const keepSetChanged = inKeepSet(existing.effective_decision) !== inKeepSet(input.decision);
  db.exec("BEGIN");
  try {
    setUserOverride(db, id, photoId, input.decision, input.reason);
    bumpInputRevision(db, id);
    invalidateForDecisionChange(
      db,
      exh,
      keepSetChanged,
      input.decision === "must_keep" && input.include_motifs,
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return ok({ decision: getDecision(db, photoId), input_revision: getExhibition(db, id)!.input_revision });
});
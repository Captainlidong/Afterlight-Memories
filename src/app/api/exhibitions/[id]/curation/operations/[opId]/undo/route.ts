import { getDb } from "@/lib/db/client";
import { getExhibition, bumpInputRevision } from "@/lib/db/repos";
import { getDecision, setUserOverride, clearOverride, countDecisions } from "@/lib/db/curation";
import {
  getOperation,
  hasLaterOperation,
  markOperationUndone,
  snapshotMatches,
  type OverrideSnapshot,
} from "@/lib/db/curationOperations";
import { isRunning } from "@/lib/orchestrator/orchestrator";
import { invalidateForDecisionChange } from "@/lib/orchestrator/rerunMatrix";
import type { UserDecisionT } from "@/lib/agents/schemas";
import { ApiError, ConcurrentRunError, ok, handler } from "@/lib/api/errors";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; opId: string }> };

const inKeepSet = (d: string) => d === "keep" || d === "must_keep";

/**
 * 撤销最近一次批量操作（任务书 v2.1 §19.5）：只恢复该次实际改变照片的原覆盖与原因。
 * 后续操作/确认 → superseded；单张编辑改了快照 → conflict；已撤销 → 幂等成功。
 * 撤销同样 bump revision + 合并 stale，不触发模型，不自动恢复确认。
 */
export const POST = handler(async (_req: Request, { params }: Ctx) => {
  const { id, opId } = await params;
  const db = getDb();
  const exh = getExhibition(db, id);
  if (!exh) throw new ApiError(404, "not_found", "影展不存在。");
  const op = getOperation(db, opId);
  if (!op || op.exhibition_id !== id) {
    throw new ApiError(404, "not_found", "操作不存在。");
  }
  if (op.undone) {
    return ok({
      operation_id: op.id,
      restored_ids: op.photo_ids,
      revision: exh.input_revision,
      counts: countDecisions(db, id),
      idempotent: true,
    });
  }
  if (op.action === "confirm_selection") {
    throw new ApiError(409, "not_undoable", "确认选片不能在这里撤销，请直接调整选片。");
  }
  if (hasLaterOperation(db, id, opId)) {
    throw new ApiError(409, "operation_superseded", "这次操作之后还有新的修改或确认，只能撤销最近一次操作。");
  }
  if (!snapshotMatches(db, op)) {
    throw new ApiError(409, "operation_conflict", "照片已被再次修改，无法撤销这次操作。");
  }
  if (isRunning(db, id)) throw new ConcurrentRunError();

  const before = op.before_json as OverrideSnapshot[];
  let revision = 0;
  let keepSetChanged = false;
  db.exec("BEGIN");
  try {
    for (const s of before) {
      const cur = getDecision(db, s.photo_id)!;
      const keepNow = inKeepSet(cur.effective_decision);
      if (s.user_override === null) clearOverride(db, id, s.photo_id);
      else setUserOverride(db, id, s.photo_id, s.user_override as UserDecisionT, s.override_reason);
      const restored = getDecision(db, s.photo_id)!;
      if (keepNow !== inKeepSet(restored.effective_decision)) keepSetChanged = true;
    }
    revision = bumpInputRevision(db, id);
    invalidateForDecisionChange(db, exh, keepSetChanged);
    markOperationUndone(db, opId);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return ok({
    operation_id: op.id,
    restored_ids: op.photo_ids,
    revision,
    counts: countDecisions(db, id),
    idempotent: false,
  });
});
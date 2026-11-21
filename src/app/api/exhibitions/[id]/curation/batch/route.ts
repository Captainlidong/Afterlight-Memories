import { getDb } from "@/lib/db/client";
import { getExhibition, bumpInputRevision } from "@/lib/db/repos";
import { getDecision, setUserOverride, clearOverride, countDecisions } from "@/lib/db/curation";
import {
  insertOperation,
  findOperationByRequest,
  type OverrideSnapshot,
  type BatchAfterSnapshot,
} from "@/lib/db/curationOperations";
import { isRunning } from "@/lib/orchestrator/orchestrator";
import { invalidateForDecisionChange } from "@/lib/orchestrator/rerunMatrix";
import { BatchCurationInput } from "@/lib/agents/schemas";
import { ApiError, ConcurrentRunError, ok, handler } from "@/lib/api/errors";
import type { CurationDecisionDTO } from "@/types";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const inKeepSet = (d: string) => d === "keep" || d === "must_keep";

/**
 * 批量策展（任务书 v2.1 §19.5）：一次服务端事务，不在浏览器循环 PATCH。
 * must_keep 默认保护跳过（include_must_keep 显式解除）；整批校验、一次 revision、
 * 一条操作历史、一次合并 stale；保留集变化使确认失效；不调用模型。
 */
export const POST = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const db = getDb();
  const exh = getExhibition(db, id);
  if (!exh) throw new ApiError(404, "not_found", "影展不存在。");
  const input = BatchCurationInput.parse(await req.json());
  const ids = [...new Set(input.photo_ids)];
  const targetDecision = input.action === "set_decision" ? input.decision! : null;

  // 幂等回放优先于 revision/并发校验：网络重试不应因状态前进而失败。
  if (input.request_id) {
    const prior = findOperationByRequest(db, id, input.request_id);
    if (prior) {
      const after = prior.after_json as BatchAfterSnapshot;
      return ok({
        operation_id: prior.id,
        changed_ids: prior.photo_ids,
        skipped_ids: after.skipped_ids,
        skipped_reason: after.skipped_reason,
        revision: prior.revision,
        counts: countDecisions(db, id),
        next_action: "confirm_selection",
        idempotent: true,
      });
    }
  }

  if (isRunning(db, id)) throw new ConcurrentRunError();
  if (input.expected_revision !== exh.input_revision) {
    throw new ApiError(409, "revision_conflict", "选片已有新的修改，请刷新后重试。");
  }

  const decisions: CurationDecisionDTO[] = [];
  for (const pid of ids) {
    const d = getDecision(db, pid);
    if (!d || d.exhibition_id !== id) {
      throw new ApiError(409, "invalid_photos", "部分照片不存在或没有筛选决定，请刷新后重试。");
    }
    decisions.push(d);
  }

  const changed: CurationDecisionDTO[] = [];
  const skippedIds: string[] = [];
  for (const d of decisions) {
    const wouldChangeMustKeep =
      d.effective_decision === "must_keep" &&
      (input.action === "restore_ai_suggestion" || targetDecision !== "must_keep");
    if (wouldChangeMustKeep && !input.include_must_keep) {
      skippedIds.push(d.photo_id);
      continue;
    }
    const alreadyTarget =
      input.action === "set_decision" ? d.user_override === targetDecision : d.user_override === null;
    if (!alreadyTarget) changed.push(d);
  }

  if (changed.length === 0) {
    if (skippedIds.length > 0) {
      return ok({
        operation_id: null,
        changed_ids: [],
        skipped_ids: skippedIds,
        skipped_reason: "must_keep_protected",
        revision: exh.input_revision,
        counts: countDecisions(db, id),
        next_action: "confirm_selection",
        idempotent: false,
      });
    }
    throw new ApiError(409, "nothing_to_change", "所选照片已经是该状态，没有需要更改的内容。");
  }

  const before: OverrideSnapshot[] = changed.map((d) => ({
    photo_id: d.photo_id,
    user_override: d.user_override,
    override_reason: d.override_reason,
  }));
  const keepBefore = new Map(changed.map((d) => [d.photo_id, inKeepSet(d.effective_decision)]));
  let revision = 0;
  let operationId = "";
  let keepSetChanged = false;
  db.exec("BEGIN");
  try {
    for (const d of changed) {
      if (targetDecision) setUserOverride(db, id, d.photo_id, targetDecision, null);
      else clearOverride(db, id, d.photo_id);
      const cur = getDecision(db, d.photo_id)!;
      if (keepBefore.get(d.photo_id) !== inKeepSet(cur.effective_decision)) keepSetChanged = true;
    }
    const after: BatchAfterSnapshot = {
      overrides: changed.map((d) => {
        const cur = getDecision(db, d.photo_id)!;
        return { photo_id: cur.photo_id, user_override: cur.user_override, override_reason: cur.override_reason };
      }),
      skipped_ids: skippedIds,
      skipped_reason: skippedIds.length > 0 ? "must_keep_protected" : null,
    };
    revision = bumpInputRevision(db, id);
    invalidateForDecisionChange(db, exh, keepSetChanged);
    const op = insertOperation(db, {
      exhibitionId: id,
      action: input.action,
      decision: targetDecision,
      photoIds: changed.map((d) => d.photo_id),
      before,
      after,
      revision,
      requestId: input.request_id ?? null,
    });
    operationId = op.id;
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return ok({
    operation_id: operationId,
    changed_ids: changed.map((d) => d.photo_id),
    skipped_ids: skippedIds,
    skipped_reason: skippedIds.length > 0 ? "must_keep_protected" : null,
    revision,
    counts: countDecisions(db, id),
    next_action: "confirm_selection",
    idempotent: false,
  });
});
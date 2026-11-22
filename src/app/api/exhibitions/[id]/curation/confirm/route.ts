import { getDb } from "@/lib/db/client";
import { getExhibition, updateExhibition, bumpInputRevision } from "@/lib/db/repos";
import { listDecisions, setUserOverride } from "@/lib/db/curation";
import { insertOperation, findOperationByRequest } from "@/lib/db/curationOperations";
import { listMotifs } from "@/lib/db/motifs";
import { isRunning, startPipeline } from "@/lib/orchestrator/orchestrator";
import { stageIndex } from "@/lib/orchestrator/stateMachine";
import { ConfirmSelectionInput } from "@/lib/agents/schemas";
import { ApiError, ConcurrentRunError, ok, handler } from "@/lib/api/errors";

import { requireVisitorMutation } from "@/lib/visitor/access";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 确认选片（任务书 v2.1 §19.3 / §19.11）：选片门的唯一钥匙。
 * 单事务写入 selection_confirmed_* + 操作历史；expected_revision 乐观并发；
 * request_id 幂等（重复提交返回同一操作，不重复跑模型）。
 * hold_policy=include 时把暂缓照片显式纳入候选（用户决定，写 user_override）。
 */
export const POST = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const db = getDb();
  requireVisitorMutation(db, req, id);
  const exh = getExhibition(db, id);
  if (!exh) throw new ApiError(404, "not_found", "影展不存在。");
  const input = ConfirmSelectionInput.parse(await req.json());

  // 幂等回放优先于并发守卫与 revision 校验：网络重试不应因已开始的任务而失败。
  if (input.request_id) {
    const prior = findOperationByRequest(db, id, input.request_id);
    if (prior) {
      const after = prior.after_json as { selection_hold_policy: "exclude" | "include" };
      return ok({
        operation_id: prior.id,
        revision: prior.revision,
        confirmed_photo_ids: prior.photo_ids,
        hold_policy: after.selection_hold_policy,
        run_id: null,
        workflow_id: null,
        idempotent: true,
        reused_motifs: false,
      });
    }
  }

  if (isRunning(db, id)) throw new ConcurrentRunError();
  const decisions = listDecisions(db, id);
  if (decisions.length === 0) {
    throw new ApiError(409, "no_curation", "还没有筛选结果，请先完成照片分析。");
  }
  if (input.expected_revision !== exh.input_revision) {
    throw new ApiError(409, "revision_conflict", "选片已有新的修改，请刷新后重新确认。");
  }

  const before = {
    decisions: decisions.map((d) => ({
      photo_id: d.photo_id,
      user_override: d.user_override,
      effective_decision: d.effective_decision,
    })),
    selection_confirmed_revision: exh.selection_confirmed_revision,
    selection_hold_policy: exh.selection_hold_policy,
  };

  let revision = 0;
  let confirmedIds: string[] = [];
  let operationId = "";
  let reuseMotifs = false;
  db.exec("BEGIN");
  try {
    if (input.hold_policy === "include") {
      for (const d of decisions) {
        if (d.effective_decision === "hold") {
          setUserOverride(db, id, d.photo_id, "keep", "确认选片时选择纳入候选");
        }
      }
    }
    confirmedIds = listDecisions(db, id)
      .filter((d) => d.effective_decision === "keep" || d.effective_decision === "must_keep")
      .map((d) => d.photo_id);
    if (confirmedIds.length === 0) {
      throw new ApiError(409, "empty_selection", "至少保留一张照片才能继续。");
    }
    // §19.3：保留集与上次确认完全一致、且现有主题未过期 → 复用，不重复发现。
    const prevConfirmed = exh.selection_confirmed_photo_ids;
    const sameSelection =
      prevConfirmed != null &&
      prevConfirmed.length === confirmedIds.length &&
      confirmedIds.every((pid) => prevConfirmed.includes(pid));
    const motifsFresh = exh.stale_from == null || stageIndex(exh.stale_from) > stageIndex("motifs");
    reuseMotifs = input.discover_motifs && sameSelection && motifsFresh && listMotifs(db, id).length > 0;
    revision = bumpInputRevision(db, id);
    updateExhibition(db, id, {
      selection_confirmed_revision: revision,
      selection_confirmed_photo_ids: JSON.stringify(confirmedIds),
      selection_hold_policy: input.hold_policy,
    });
    const op = insertOperation(db, {
      exhibitionId: id,
      action: "confirm_selection",
      photoIds: confirmedIds,
      before,
      after: {
        selection_confirmed_revision: revision,
        selection_confirmed_photo_ids: confirmedIds,
        selection_hold_policy: input.hold_policy,
      },
      revision,
      requestId: input.request_id ?? null,
    });
    operationId = op.id;
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const run = input.discover_motifs && !reuseMotifs ? startPipeline(db, id, "motifs", "motifs") : null;
  return ok({
    operation_id: operationId,
    revision,
    confirmed_photo_ids: confirmedIds,
    hold_policy: input.hold_policy,
    run_id: run?.run_id ?? null,
    workflow_id: run?.workflow_id ?? null,
    idempotent: false,
    reused_motifs: reuseMotifs,
  });
});
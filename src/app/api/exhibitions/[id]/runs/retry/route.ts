import { getDb } from "@/lib/db/client";
import { getExhibition } from "@/lib/db/repos";
import { startPipeline } from "@/lib/orchestrator/orchestrator";
import { retryRange, gateCeiling } from "@/lib/orchestrator/rerunMatrix";
import { stageIndex } from "@/lib/orchestrator/stateMachine";
import { ApiError, ok, handler } from "@/lib/api/errors";

import { requireVisitorMutation } from "@/lib/visitor/access";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** 重试失败阶段：failed_stage→qa（矩阵「重试失败阶段」），前阶段结果不动；不越过用户确认门。 */
export const POST = handler(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const db = getDb();
  requireVisitorMutation(db, _req, id);
  const exh = getExhibition(db, id);
  if (!exh) throw new ApiError(404, "not_found", "影展不存在。");
  if (!exh.failed_stage) {
    throw new ApiError(409, "no_failed_stage", "当前没有失败的阶段可重试。");
  }
  const first = exh.stale_from && stageIndex(exh.stale_from) < stageIndex(exh.failed_stage) ? exh.stale_from : exh.failed_stage;
  const { from, to } = retryRange(first, "qa");
  const end = gateCeiling(exh, to);
  const { run_id, workflow_id } = startPipeline(db, id, from, end);
  return ok({ run_id, workflow_id }, { status: 202 });
});
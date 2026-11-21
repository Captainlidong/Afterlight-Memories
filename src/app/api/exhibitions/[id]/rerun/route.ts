import { getDb } from "@/lib/db/client";
import { getExhibition } from "@/lib/db/repos";
import { startPipeline } from "@/lib/orchestrator/orchestrator";
import { gateCeiling } from "@/lib/orchestrator/rerunMatrix";
import { ApiError, ok, handler } from "@/lib/api/errors";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 横幅「更新影展」：从 stale_from 精确重跑到 qa（重跑矩阵 §7.3），不越过用户确认门。
 * 编辑只设 stale_from 不自动重跑；无过期 → 409 nothing_stale。
 */
export const POST = handler(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const db = getDb();
  const exh = getExhibition(db, id);
  if (!exh) throw new ApiError(404, "not_found", "影展不存在。");
  if (!exh.stale_from) {
    throw new ApiError(409, "nothing_stale", "当前没有过期的阶段，无需重跑。");
  }
  const { run_id, workflow_id } = startPipeline(db, id, exh.stale_from, gateCeiling(exh, "qa"));
  return ok({ run_id, workflow_id }, { status: 202 });
});
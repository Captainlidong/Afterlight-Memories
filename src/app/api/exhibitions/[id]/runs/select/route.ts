import { getDb } from "@/lib/db/client";
import { countPhotos, listInspections } from "@/lib/db/photos";
import { startPipelineOnce } from "@/lib/orchestrator/orchestrator";
import { RunTriggerInput } from "@/lib/agents/schemas";
import { ApiError, ok, handler } from "@/lib/api/errors";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** 触发审美筛选（仅 select 阶段，支持局部重跑；不触碰用户 must_keep 覆盖）。 */
export const POST = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const db = getDb();
  if (countPhotos(db, id) === 0) {
    throw new ApiError(400, "no_photos", "还没有照片，请先上传素材。");
  }
  if (listInspections(db, id).length === 0) {
    throw new ApiError(400, "no_inspections", "还没有完成照片分析，请先在素材页分析照片。");
  }
  const input = RunTriggerInput.parse(await req.json().catch(() => ({})));
  const { run_id, workflow_id, idempotent } = startPipelineOnce(db, id, "select", "select", input.request_id);
  return ok({ run_id, workflow_id, idempotent }, { status: 202 });
});
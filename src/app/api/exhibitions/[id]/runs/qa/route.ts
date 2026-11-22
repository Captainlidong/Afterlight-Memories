import { getDb } from "@/lib/db/client";
import { countPhotos, listInspections } from "@/lib/db/photos";
import { getLayout } from "@/lib/db/layout";
import { startPipelineOnce } from "@/lib/orchestrator/orchestrator";
import { RunTriggerInput } from "@/lib/agents/schemas";
import { ApiError, ok, handler } from "@/lib/api/errors";

import { requireVisitorMutation } from "@/lib/visitor/access";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** 单独重跑质检（qa→qa）。门：无布局 → 409 layout_not_ready。 */
export const POST = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const db = getDb();
  requireVisitorMutation(db, req, id);
  if (countPhotos(db, id) === 0) {
    throw new ApiError(400, "no_photos", "还没有照片，请先上传素材。");
  }
  if (listInspections(db, id).length === 0) {
    throw new ApiError(400, "no_inspections", "还没有完成照片分析，请先在素材页分析照片。");
  }
  if (!getLayout(db, id)) {
    throw new ApiError(409, "layout_not_ready", "请先生成布局，再进行策展质检。");
  }
  const input = RunTriggerInput.parse(await req.json().catch(() => ({})));
  const { run_id, workflow_id, idempotent } = startPipelineOnce(db, id, "qa", "qa", input.request_id);
  return ok({ run_id, workflow_id, idempotent }, { status: 202 });
});
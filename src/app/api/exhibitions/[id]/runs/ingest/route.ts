import { getDb } from "@/lib/db/client";
import { countPhotos } from "@/lib/db/photos";
import { startPipelineOnce } from "@/lib/orchestrator/orchestrator";
import { RunTriggerInput } from "@/lib/agents/schemas";
import { ApiError, ok, handler } from "@/lib/api/errors";
import { aiWindowNow } from "@/lib/ai/schedule";
import { assertVisitorAiExperienceStart, markVisitorAiExperience } from "@/lib/visitor/quota";

import { requireVisitorMutation } from "@/lib/visitor/access";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** 默认分析只跑 ingest→select，停在「确认选片」门（任务书 v2.1 §19.1）；主题发现在确认后才开始。 */
export const POST = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const db = getDb();
  requireVisitorMutation(db, req, id);
  if (countPhotos(db, id) === 0) {
    throw new ApiError(400, "no_photos", "还没有照片，请先上传素材。");
  }
  // 公网访客 AI 体验约束：空闲时段 + 次数额度 + 照片上限（AI 模式影展才受约束）。
  const gate = assertVisitorAiExperienceStart(db, req, id, () => aiWindowNow());
  const input = RunTriggerInput.parse(await req.json().catch(() => ({})));
  const { run_id, workflow_id, idempotent } = startPipelineOnce(db, id, "ingest", "select", input.request_id);
  if (gate.shouldMark) markVisitorAiExperience(db, req, id);
  return ok({ run_id, workflow_id, idempotent }, { status: 202 });
});
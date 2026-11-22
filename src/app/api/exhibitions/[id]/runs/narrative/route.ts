import { getDb } from "@/lib/db/client";
import { countPhotos, listInspections } from "@/lib/db/photos";
import { getExhibition } from "@/lib/db/repos";
import { insertRegenerationIntent } from "@/lib/db/regenerations";
import { startPipelineOnce } from "@/lib/orchestrator/orchestrator";
import { RunNarrativeInput } from "@/lib/agents/schemas";
import { ApiError, ok, handler } from "@/lib/api/errors";

import { requireVisitorMutation } from "@/lib/visitor/access";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 触发叙事重跑（narrative→qa）。叙事门：未选主题 → 409 theme_not_selected。
 * 与 regenerate 不同：本路由预留 preserve 意图保留全部编辑，成功发布才写可选 tone，
 * 对应重跑矩阵「改语气 → narrative→qa」。
 */
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
  const input = RunNarrativeInput.parse(await req.json().catch(() => ({})));
  const { run_id, workflow_id, idempotent } = startPipelineOnce(db, id, "narrative", "qa", input.request_id, {
    reserve: (tx, ids) => {
      const exh = getExhibition(tx, id);
      if (!exh) throw new ApiError(404, "not_found", "影展不存在。");
      insertRegenerationIntent(tx, {
        runId: ids.runId, exhibitionId: id, workflowId: ids.workflowId,
        scope: "preserve", tone: input.tone ?? null, expectedInputRevision: exh.input_revision,
      });
    },
  });
  return ok({ run_id, workflow_id, idempotent }, { status: 202 });
});
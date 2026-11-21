import { getDb } from "@/lib/db/client";
import { getExhibition } from "@/lib/db/repos";
import { listPhotos } from "@/lib/db/photos";
import { listRuns } from "@/lib/db/runs";
import { getNarrative } from "@/lib/db/narrative";
import { getLayout } from "@/lib/db/layout";
import { getQa } from "@/lib/db/qa";
import { isRunning } from "@/lib/orchestrator/orchestrator";
import { loadAiConfig } from "@/lib/ai/config";
import { getExhibitionAiUsage } from "@/lib/ai/usage";
import { ApiError, ok, handler } from "@/lib/api/errors";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** 轮询载荷（前端 SWR refreshInterval=isRunning?800:0）。runs 只回摘要，详情走 /runs/[runId]。 */
export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const db = getDb();
  const exhibition = getExhibition(db, id);
  if (!exhibition) throw new ApiError(404, "not_found", "影展不存在。");

  const photos = listPhotos(db, id);
  const counts = {
    total: photos.length,
    uploaded: photos.filter((p) => p.status === "uploaded").length,
    inspected: photos.filter((p) => p.status === "inspected").length,
    failed: photos.filter((p) => p.status === "failed").length,
  };

  const allRuns = listRuns(db, id);
  const runs = allRuns.map((r) => ({
    id: r.id,
    agent_type: r.agent_type,
    status: r.status,
    input_version: r.input_version,
    workflow_id: r.workflow_id,
    input_revision: r.input_revision,
    duration_ms: r.duration_ms,
    error_message: r.error_message,
    created_at: r.created_at,
    finished_at: r.finished_at,
  }));
  const latestWorkflow = [...allRuns].reverse().find((r) => r.workflow_id)?.workflow_id ?? null;

  return ok({
    exhibition: {
      id: exhibition.id,
      title: exhibition.title,
      status: exhibition.status,
      failed_stage: exhibition.failed_stage,
      stale_from: exhibition.stale_from,
      current_version: exhibition.current_version,
      input_revision: exhibition.input_revision,
      selection_confirmed_revision: exhibition.selection_confirmed_revision,
      selection_confirmed_photo_ids: exhibition.selection_confirmed_photo_ids,
      selection_hold_policy: exhibition.selection_hold_policy,
      mode: exhibition.mode,
      allow_external_ai: exhibition.allow_external_ai,
      is_demo_set: exhibition.is_demo_set,
      selected_motif_id: exhibition.selected_motif_id,
      template: exhibition.template,
      tone: exhibition.tone,
    },
    is_running: isRunning(db, id),
    workflow_id: latestWorkflow,
    photos: counts,
    ai_usage: exhibition.mode === "ai" ? getExhibitionAiUsage(db, id, latestWorkflow, loadAiConfig()) : null,
    progress: {
      narrative: getNarrative(db, id) != null,
      layout: getLayout(db, id) != null,
      qa: getQa(db, id) != null,
    },
    runs,
  });
});
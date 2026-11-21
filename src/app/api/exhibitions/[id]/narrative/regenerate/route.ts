import { getDb } from "@/lib/db/client";
import { getExhibition } from "@/lib/db/repos";
import { insertRegenerationIntent } from "@/lib/db/regenerations";
import { startPipelineOnce } from "@/lib/orchestrator/orchestrator";
import { RegenerateNarrativeInput } from "@/lib/agents/schemas";
import { ApiError, ok, handler } from "@/lib/api/errors";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 重新生成叙事（§提示词8 / v3 R01）。丢弃编辑需要用户显式选择 scope：
 * - unlocked（默认）：只替换非锁定编辑，锁定行保留并由 merge 回放；
 * - all：用户显式丢弃全部编辑（含锁定）。
 * 旧编辑与语气只在本次叙事成功发布时才被替换 —— 意图与 run 同事务预留，
 * 运行中/主题未选/配置缺失等拒绝一律不留下副作用；带 request_id 时幂等。
 */
export const POST = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const db = getDb();
  if (!getExhibition(db, id)) throw new ApiError(404, "not_found", "影展不存在。");
  const input = RegenerateNarrativeInput.parse(await req.json().catch(() => ({})));

  const { run_id, workflow_id } = startPipelineOnce(db, id, "narrative", "qa", input.request_id, {
    reserve: (tx, ids) => {
      const exh = getExhibition(tx, id);
      if (!exh) throw new ApiError(404, "not_found", "影展不存在。");
      insertRegenerationIntent(tx, {
        runId: ids.runId,
        exhibitionId: id,
        workflowId: ids.workflowId,
        scope: input.scope,
        tone: input.tone ?? null,
        expectedInputRevision: exh.input_revision,
      });
    },
  });
  return ok({ run_id, workflow_id }, { status: 202 });
});

import type { DatabaseSync } from "node:sqlite";
import { getExhibition, updateExhibition } from "../db/repos";
import { createRun, updateRun, getRun, hasRunningRun } from "../db/runs";
import { getWorkflowRequest, insertWorkflowRequest } from "../db/workflowRequests";
import { newId, now } from "../id";
import { ApiError, ConcurrentRunError } from "../api/errors";
import { AiError } from "../ai/errors";
import { loadAiConfig } from "../ai/config";
import { bindCurationWorkflow } from "../db/curationJobs";
import { AI_ERROR_GUIDANCE } from "../ai/feedback";
import { STAGE_META, stagesBetween, type Stage } from "./stateMachine";
import {
  FENCED_CODE,
  acquireLease,
  ensureExecutionOwner,
  recoverOrphanedTasks,
  releaseLease,
  startHeartbeat,
} from "./recovery";
import { demoStageDelay } from "./demoDelay";
import { runIngest } from "../agents/materialSteward";
import { runSelect } from "../agents/aestheticSelector";
import { runMotifs } from "../agents/motifFinder";
import { runNarrative } from "../agents/narrativeEditor";
import { runExhibition } from "../agents/exhibitionDesigner";
import { runQa } from "../agents/curatorialQa";
import type { Exhibition } from "@/types";

/**
 * 策展编排器（设计文档 §7.1）。
 * 路由创建首个 run 行后 void runPipeline 立即返回 {run_id}；前端轮询 /status。
 * 每阶段：running → 调 agent（内部单事务持久化 + zod 校验）→ completed + done 状态。
 * 失败：run failed + status=stage_failed + failed_stage，前阶段表不动，下游 skipped。
 * 并发守卫：内存 Map（进程内）+ DB running-run（热重载后仍有效）→ 409。
 */
export interface StageContext {
  runId: string;
  workflowId: string;
  exhibition: Exhibition;
  /** 在发布写入的同一短事务内调用；验证 running run、未过期租约及冻结 revision，失效抛 run_fenced。 */
  assertOwner?: () => void;
}
export type StageRunner = (db: DatabaseSync, ctx: StageContext) => Promise<unknown>;

const registry: Partial<Record<Stage, StageRunner>> = {
  ingest: runIngest,
  select: runSelect,
  motifs: runMotifs,
  narrative: runNarrative,
  layout: runExhibition,
  qa: runQa,
};

const g = globalThis as unknown as { __afterlightRunning?: Map<string, boolean> };
const running: Map<string, boolean> = g.__afterlightRunning ?? (g.__afterlightRunning = new Map());

export function isRunning(db: DatabaseSync, exhibitionId: string): boolean {
  return running.has(exhibitionId) || hasRunningRun(db, exhibitionId);
}

interface PreparedPipeline {
  run_id: string;
  workflow_id: string;
  stages: Stage[];
  /** 触发时冻结：整条 workflow 后续阶段沿用，避免读取到更新的混合输入。 */
  input_version: number;
  input_revision: number;
}

/** 预检 + 建 run 行 + 置运行态；不启动异步管线（供带事务的幂等触发在提交后启动）。 */
function preparePipeline(
  db: DatabaseSync,
  exhibitionId: string,
  from: Stage,
  to: Stage,
): PreparedPipeline {
  // 触发前回收失活租约（运行期不做无租约扫描，避免误伤手工/测试中的 running 行）。
  recoverOrphanedTasks(db, { includeUnleasedRuns: false });

  const exh = getExhibition(db, exhibitionId);
  if (!exh) throw new ApiError(404, "not_found", "影展不存在。");
  if (isRunning(db, exhibitionId)) throw new ConcurrentRunError();

  const stages = stagesBetween(from, to);
  if (stages.length === 0) {
    throw new ApiError(400, "invalid_stage_range", `非法阶段范围：${from} → ${to}。`);
  }
  // 确认选片门（§19.1）：进入 motifs 前必须已确认选片。
  if (stages.includes("motifs") && exh.selection_confirmed_revision == null) {
    throw new ApiError(409, "selection_not_confirmed", "请先确认选片，再开始主题发现。");
  }
  // 叙事门（§5.1 GATE）：进入 narrative 前必须已选主题主线。
  if (stages.includes("narrative") && !exh.selected_motif_id) {
    throw new ApiError(409, "theme_not_selected", "请先选择一个主题主线，再生成叙事。");
  }
  for (const s of stages) {
    if (!registry[s]) {
      throw new ApiError(501, "stage_not_implemented", `阶段「${STAGE_META[s].label}」尚未实现。`);
    }
  }

  // 一次触发 = 一个 workflow：链上所有 run 共享 workflow_id + 触发时的 input_revision，
  // 前端自动前进只认本次 workflow（§19.2），历史成功不会误跳。
  const workflowId = newId("wf");
  if (exh.mode === "ai") bindCurationWorkflow(db, exh, workflowId, loadAiConfig().maxCallsPerJob);
  const firstMeta = STAGE_META[stages[0]];
  const frozenVersion = exh.current_version;
  const frozenRevision = exh.input_revision;
  const run = createRun(db, {
    exhibitionId,
    agentType: firstMeta.agent,
    status: "running",
    inputVersion: frozenVersion,
    workflowId,
    inputRevision: frozenRevision,
  });
  updateExhibition(db, exhibitionId, { status: firstMeta.running, failed_stage: null });
  acquireLease(db, { exhibitionId, runId: run.id, workflowId }, { heartbeat: false });
  return {
    run_id: run.id,
    workflow_id: workflowId,
    stages,
    input_version: frozenVersion,
    input_revision: frozenRevision,
  };
}

function launchPipeline(db: DatabaseSync, exhibitionId: string, p: PreparedPipeline): void {
  startHeartbeat(db, exhibitionId, p.run_id);
  running.set(exhibitionId, true);
  void executePipeline(db, exhibitionId, p.stages, p.run_id, p.workflow_id, p.input_version, p.input_revision);
}

export function startPipeline(
  db: DatabaseSync,
  exhibitionId: string,
  from: Stage,
  to: Stage,
): { run_id: string; workflow_id: string } {
  const { run_id, workflow_id } = startPipelineOnce(db, exhibitionId, from, to);
  return { run_id, workflow_id };
}

/**
 * 幂等触发（任务书 v2.1 §19.2.9）：带 request_id 时，重试返回同一 workflow，
 * 不重复启动管线、不重复扣费。幂等回放优先于并发守卫（运行中重试也不报 409）。
 * 无 request_id 时等价于 startPipeline。
 */
export function startPipelineOnce(
  db: DatabaseSync,
  exhibitionId: string,
  from: Stage,
  to: Stage,
  requestId?: string | null,
  opts?: {
    /** 与 run/workflow 同一事务写入的预留动作（如 R01 重跑意图）；抛错则整体回滚。 */
    reserve?: (db: DatabaseSync, ids: { runId: string; workflowId: string }) => void;
  },
): { run_id: string; workflow_id: string; idempotent: boolean } {
  if (requestId) {
    const prior = getWorkflowRequest(db, exhibitionId, requestId);
    if (prior) {
      return { run_id: prior.run_id, workflow_id: prior.workflow_id, idempotent: true };
    }
  }
  // 预检、建 run、幂等键、预留意图必须原子：任一失败都不留下半个 workflow。
  db.exec("BEGIN IMMEDIATE");
  let prepared: PreparedPipeline;
  try {
    prepared = preparePipeline(db, exhibitionId, from, to);
    if (requestId) {
      insertWorkflowRequest(db, {
        exhibitionId,
        requestId,
        workflowId: prepared.workflow_id,
        runId: prepared.run_id,
      });
    }
    opts?.reserve?.(db, { runId: prepared.run_id, workflowId: prepared.workflow_id });
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  launchPipeline(db, exhibitionId, prepared);
  return { run_id: prepared.run_id, workflow_id: prepared.workflow_id, idempotent: false };
}

/** 统一发布判定；调用者负责把检查与写入放在同一 BEGIN IMMEDIATE 内。 */
function executionFence(
  db: DatabaseSync, exhibitionId: string, runId: string, workflowId: string, frozenRevision: number,
): ApiError | null {
  const row = getRun(db, runId);
  const current = getExhibition(db, exhibitionId);
  let cause: string | null = null;
  if (!row || row.status !== "running" || row.exhibition_id !== exhibitionId || row.workflow_id !== workflowId) {
    cause = "run_not_running";
  } else if (!current || current.input_revision !== frozenRevision || row.input_revision !== frozenRevision) {
    cause = "stale_input";
  } else if (!ensureExecutionOwner(db, exhibitionId, workflowId)) {
    cause = "lease_lost";
  }
  return cause ? new ApiError(409, "run_fenced", `${FENCED_CODE} [${cause}] 执行权或输入已失效，本次结果不会发布。`, { cause }) : null;
}

async function executePipeline(
  db: DatabaseSync,
  exhibitionId: string,
  stages: Stage[],
  firstRunId: string,
  workflowId: string,
  frozenVersion: number,
  frozenRevision: number,
): Promise<void> {
  let nextRunId = firstRunId;
  try {
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      const meta = STAGE_META[stage];
      const runId = nextRunId;
      const started = Date.now();
      const assertOwner = () => {
        const fence = executionFence(db, exhibitionId, runId, workflowId, frozenRevision);
        if (fence) throw fence;
      };
      const skipDownstream = () => {
        for (let j = i + 1; j < stages.length; j++) {
          createRun(db, {
            exhibitionId, agentType: STAGE_META[stages[j]].agent, status: "skipped",
            inputVersion: frozenVersion, workflowId, inputRevision: frozenRevision,
          });
        }
      };
      try {
        const exh = getExhibition(db, exhibitionId);
        if (exh) await demoStageDelay(stage, exh);
        db.exec("BEGIN IMMEDIATE");
        try {
          assertOwner();
          db.exec("COMMIT");
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw error;
        }
        const output = await registry[stage]!(db, { runId, workflowId, exhibition: exh!, assertOwner });
        db.exec("BEGIN IMMEDIATE");
        try {
          // 阶段后仍检查 run + lease + revision；与完成状态、门/下一阶段同一事务。
          assertOwner();
          updateRun(db, runId, {
            status: "completed", output, duration_ms: Date.now() - started, finished_at: now(),
          });
          updateExhibition(db, exhibitionId, { status: meta.done, failed_stage: null });
          const current = getExhibition(db, exhibitionId)!;
          const atGate = (stage === "select" && current.selection_confirmed_revision == null) ||
            (stage === "motifs" && stages[i + 1] === "narrative" && !current.selected_motif_id);
          if (atGate) skipDownstream();
          else if (i + 1 < stages.length) {
            const nextMeta = STAGE_META[stages[i + 1]];
            nextRunId = createRun(db, {
              exhibitionId, agentType: nextMeta.agent, status: "running",
              inputVersion: frozenVersion, workflowId, inputRevision: frozenRevision,
            }).id;
            updateExhibition(db, exhibitionId, { status: nextMeta.running });
          }
          db.exec("COMMIT");
          if (atGate) return;
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw error;
        }
      } catch (err) {
        db.exec("BEGIN IMMEDIATE");
        try {
          // 普通网络/校验错误也可能晚于接管：先 fence，不让旧错误覆盖新状态。
          const fence = executionFence(db, exhibitionId, runId, workflowId, frozenRevision) ??
            (err instanceof ApiError && err.code === "run_fenced" ? err : null);
          const failure = fence ?? err;
          const message = failure instanceof AiError ? AI_ERROR_GUIDANCE[failure.cls] :
            failure instanceof Error ? failure.message : "处理未完成，请重试。";
          if (fence) {
            // 只终止本 workflow 尚未结算的旧行；恢复/新 owner 已结算的行保持原样。
            db.prepare(`UPDATE agent_runs SET status='failed', error_message=?, duration_ms=?, finished_at=?
              WHERE id=? AND exhibition_id=? AND workflow_id=? AND status='running'`).run(
              message, Date.now() - started, now(), runId, exhibitionId, workflowId,
            );
          } else {
            updateRun(db, runId, { status: "failed", error_message: message, duration_ms: Date.now() - started, finished_at: now() });
            updateExhibition(db, exhibitionId, { status: "stage_failed", failed_stage: stage });
            skipDownstream();
          }
          db.exec("COMMIT");
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw error;
        }
        return;
      }
    }
  } finally {
    releaseLease(db, exhibitionId, firstRunId);
    running.delete(exhibitionId);
  }
}
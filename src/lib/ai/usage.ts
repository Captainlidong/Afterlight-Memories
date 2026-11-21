import type { DatabaseSync } from "node:sqlite";
import type { AiConfig } from "./config";
import { dayKeyInTz, hourKeyInTz, getBudgetUsage } from "./budget";
import { getCurationJob } from "../db/curationJobs";
import { getExhibition } from "../db/repos";
import { listRuns } from "../db/runs";
import { listAiCalls } from "./records";
import { desensitize } from "./errors";
import type { IngestOutput } from "../agents/materialSteward";
import { getAiActivity } from "./limiter";

export function getExhibitionAiUsage(db: DatabaseSync, exhibitionId: string, workflowId: string | null, config: AiConfig, date = new Date()) {
  const job = getCurationJob(db, exhibitionId);
  const limit = Math.min(job?.max_calls ?? config.maxCallsPerJob, config.maxCallsPerJob);
  const used = job ? getBudgetUsage(db, { scopeType: "job", scopeId: job.id, periodKey: "total" })
    : (db.prepare("SELECT COUNT(*) AS n FROM ai_calls WHERE exhibition_id=? AND purpose!='connection_test' AND status!='released'").get(exhibitionId) as { n: number }).n;
  const dailyUsed = getBudgetUsage(db, { scopeType: "global", scopeId: "*", periodKey: dayKeyInTz(config.dayTimezone, date) });
  const hourlyUsed = getBudgetUsage(db, { scopeType: "connection_test", scopeId: "*", periodKey: hourKeyInTz(config.dayTimezone, date) });
  const calls = workflowId ? listAiCalls(db, { exhibitionId, scopeId: workflowId, limit: 1_000_000 }).filter(c => ["sent", "succeeded", "failed"].includes(c.status)) : [];
  const knownUsage = calls.filter(c => c.usage?.total_tokens != null);
  const probes = listAiCalls(db, { purpose: "connection_test", limit: 1 });
  const lastProbe = probes[0];
  const latestProbeCalls = lastProbe ? listAiCalls(db, { scopeType: "connection_test", scopeId: lastProbe.scope_id }).filter(c => ["sent", "succeeded", "failed"].includes(c.status)) : [];
  // 本次进度只能来自本次 workflow，不能把上轮 30/30 冒充新任务完成。
  const ingest = workflowId ? [...listRuns(db, exhibitionId)].reverse()
    .find(r => r.agent_type === "material_steward" && r.workflow_id === workflowId) : undefined;
  const output = ingest?.output_json as Partial<IngestOutput> | null;
  const revision = getExhibition(db, exhibitionId)?.input_revision;
  const material = output && Array.isArray(output.photo_results) && typeof output.total === "number" ? {
    run_id: ingest!.id, workflow_id: ingest!.workflow_id,
    current_input: ingest!.input_revision === revision,
    total: output.total, processed: output.processed ?? 0, reused: output.reused ?? 0,
    newly_completed: output.newly_completed ?? 0, failed: output.failed ?? 0, pending: output.pending ?? 0,
  } : null;
  return {
    workflow_id: workflowId,
    activity: getAiActivity(config, { exhibitionId, workflowId }),
    run: {
      attempts: calls.length, succeeded: calls.filter(c => c.status === "succeeded").length,
      failed: calls.filter(c => c.status === "failed").length,
      uncertain: calls.filter(c => c.status === "sent").length,
      unknown_usage: calls.length - knownUsage.length,
      known_total_tokens: knownUsage.length ? knownUsage.reduce((n, c) => n + c.usage!.total_tokens!, 0) : null,
      duration_ms: calls.reduce((n, c) => n + (c.duration_ms ?? 0), 0),
      models: [...new Set(calls.map(c => desensitize(c.model, config.apiKey ? [config.apiKey] : [])))],
      errors: [...new Set(calls.flatMap(c => c.error_class ? [c.error_class] : []))],
    },
    business: { used, limit, remaining: Math.max(0, limit - used) },
    daily: { used: dailyUsed, limit: config.maxCallsPerDay, remaining: Math.max(0, config.maxCallsPerDay - dailyUsed), timezone: config.dayTimezone },
    probes: { hourly_used: hourlyUsed, hourly_limit: config.connectionTestLimitPerHour, latest_attempts: latestProbeCalls.length, latest_at: lastProbe?.created_at ?? null },
    material,
    cost: "unpriced" as const,
  };
}

export type ExhibitionAiUsage = ReturnType<typeof getExhibitionAiUsage>;

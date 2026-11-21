import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { newId, now } from "../id";
import type { AiUsage } from "./schemas";

/**
 * 模型调用记录（任务书 v3 §7.1）：每次真实外发（含重试、连接测试）都必须记账。
 * 不保存请求体、图片 Base64、Key、Authorization 头或未经脱敏的服务商错误；
 * usage 缺失记 null（未知），不能用 0 表示免费。
 */

export type AiScopeType = "workflow" | "job" | "connection_test";
export type AiPurpose = "vision" | "curation" | "motifs" | "narrative" | "connection_test";
export type AiCallStatus = "reserved" | "sent" | "succeeded" | "failed" | "released";

export interface AiCallRecord {
  id: string;
  exhibition_id: string | null;
  scope_type: AiScopeType;
  scope_id: string;
  agent_type: string | null;
  workflow_id: string | null;
  provider: string;
  model: string;
  purpose: AiPurpose;
  prompt_version: string | null;
  schema_version: string | null;
  preprocess_version: string | null;
  attempt: number;
  status: AiCallStatus;
  duration_ms: number | null;
  usage: AiUsage | null;
  provider_request_id: string | null;
  error_class: string | null;
  error_message: string | null;
  budget_period_keys: string[] | null;
  created_at: string;
  finished_at: string | null;
}

interface AiCallRow {
  id: string;
  exhibition_id: string | null;
  scope_type: string;
  scope_id: string;
  agent_type: string | null;
  workflow_id: string | null;
  provider: string;
  model: string;
  purpose: string;
  prompt_version: string | null;
  schema_version: string | null;
  preprocess_version: string | null;
  attempt: number;
  status: string;
  duration_ms: number | null;
  usage_json: string | null;
  provider_request_id: string | null;
  error_class: string | null;
  error_message: string | null;
  budget_period_keys: string | null;
  created_at: string;
  finished_at: string | null;
}

function mapRow(r: AiCallRow): AiCallRecord {
  return {
    id: r.id,
    exhibition_id: r.exhibition_id,
    scope_type: r.scope_type as AiScopeType,
    scope_id: r.scope_id,
    agent_type: r.agent_type,
    workflow_id: r.workflow_id,
    provider: r.provider,
    model: r.model,
    purpose: r.purpose as AiPurpose,
    prompt_version: r.prompt_version,
    schema_version: r.schema_version,
    preprocess_version: r.preprocess_version,
    attempt: r.attempt,
    status: r.status as AiCallStatus,
    duration_ms: r.duration_ms,
    usage: r.usage_json ? (JSON.parse(r.usage_json) as AiUsage) : null,
    provider_request_id: r.provider_request_id,
    error_class: r.error_class,
    error_message: r.error_message,
    budget_period_keys: r.budget_period_keys ? (JSON.parse(r.budget_period_keys) as string[]) : null,
    created_at: r.created_at,
    finished_at: r.finished_at,
  };
}

export interface NewAiCallInput {
  exhibitionId: string | null;
  scopeType: AiScopeType;
  scopeId: string;
  agentType?: string | null;
  workflowId?: string | null;
  provider: string;
  model: string;
  purpose: AiPurpose;
  promptVersion?: string | null;
  schemaVersion?: string | null;
  preprocessVersion?: string | null;
  attempt?: number;
  budgetPeriodKeys?: string[];
  createdAt?: string;
}

/** 新建调用记录（状态 reserved：已预留未外发）。 */
export function createAiCall(db: DatabaseSync, input: NewAiCallInput): AiCallRecord {
  const id = newId("aicall");
  db.prepare(
    `INSERT INTO ai_calls
      (id, exhibition_id, scope_type, scope_id, agent_type, workflow_id, provider, model,
       purpose, prompt_version, schema_version, preprocess_version, attempt, status,
       budget_period_keys, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'reserved', ?, ?)`,
  ).run(
    id,
    input.exhibitionId ?? null,
    input.scopeType,
    input.scopeId,
    input.agentType ?? null,
    input.workflowId ?? null,
    input.provider,
    input.model,
    input.purpose,
    input.promptVersion ?? null,
    input.schemaVersion ?? null,
    input.preprocessVersion ?? null,
    input.attempt ?? 1,
    input.budgetPeriodKeys ? JSON.stringify(input.budgetPeriodKeys) : null,
    input.createdAt ?? now(),
  );
  return getAiCall(db, id)!;
}

export interface AiCallUpdate {
  status?: AiCallStatus;
  duration_ms?: number | null;
  usage?: AiUsage | null;
  provider_request_id?: string | null;
  error_class?: string | null;
  error_message?: string | null;
  finished_at?: string | null;
}

export function updateAiCall(db: DatabaseSync, callId: string, fields: AiCallUpdate): void {
  const sets: string[] = [];
  const values: SQLInputValue[] = [];
  if (fields.status !== undefined) {
    sets.push("status=?");
    values.push(fields.status);
  }
  if (fields.duration_ms !== undefined) {
    sets.push("duration_ms=?");
    values.push(fields.duration_ms);
  }
  if (fields.usage !== undefined) {
    sets.push("usage_json=?");
    values.push(fields.usage === null ? null : JSON.stringify(fields.usage));
  }
  if (fields.provider_request_id !== undefined) {
    sets.push("provider_request_id=?");
    values.push(fields.provider_request_id);
  }
  if (fields.error_class !== undefined) {
    sets.push("error_class=?");
    values.push(fields.error_class);
  }
  if (fields.error_message !== undefined) {
    sets.push("error_message=?");
    values.push(fields.error_message);
  }
  if (fields.finished_at !== undefined) {
    sets.push("finished_at=?");
    values.push(fields.finished_at);
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE ai_calls SET ${sets.join(", ")} WHERE id=?`).run(...values, callId);
}

export function getAiCall(db: DatabaseSync, callId: string): AiCallRecord | null {
  const r = db.prepare("SELECT * FROM ai_calls WHERE id=?").get(callId) as AiCallRow | undefined;
  return r ? mapRow(r) : null;
}

export function listAiCalls(
  db: DatabaseSync,
  opts: { exhibitionId?: string; scopeType?: AiScopeType; scopeId?: string; purpose?: AiPurpose; limit?: number } = {},
): AiCallRecord[] {
  const where: string[] = [];
  const values: SQLInputValue[] = [];
  if (opts.exhibitionId !== undefined) {
    where.push("exhibition_id=?");
    values.push(opts.exhibitionId);
  }
  if (opts.scopeType !== undefined) {
    where.push("scope_type=?");
    values.push(opts.scopeType);
  }
  if (opts.scopeId !== undefined) {
    where.push("scope_id=?");
    values.push(opts.scopeId);
  }
  if (opts.purpose !== undefined) {
    where.push("purpose=?");
    values.push(opts.purpose);
  }
  const sql = `SELECT * FROM ai_calls ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...values, opts.limit ?? 500) as unknown as AiCallRow[];
  return rows.map(mapRow);
}

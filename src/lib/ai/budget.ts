import type { DatabaseSync } from "node:sqlite";
import { AiBudgetError } from "./errors";
import { ensureCurationJob } from "../db/curationJobs";
import {
  createAiCall,
  getAiCall,
  type AiCallRecord,
  type AiScopeType,
  type NewAiCallInput,
} from "./records";

/**
 * 模型调用预算（任务书 v3 §7.3）：短事务原子预留调用名额，请求后结算。
 * - 预留（reserved）= 已占额未外发，可安全释放并归还名额；
 * - 发出（sent/succeeded/failed）= 服务商可能已受理并计费，保守占额，不退还；
 * - 进程崩溃遗留的 reserved 行由 releaseStaleAiReservations 在启动时归还。
 * 计数键冗余写入 ai_calls.budget_period_keys，回收时精确归还，不依赖当时配置。
 */

export interface BudgetLimits {
  maxCallsPerJob: number;
  maxCallsPerDay: number;
  connectionTestLimitPerHour: number;
  dayTimezone: string;
}

function formatInTz(date: Date, tz: string, includeHour: boolean): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: includeHour ? "2-digit" : undefined,
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const key = `${get("year")}-${get("month")}-${get("day")}`;
  return includeHour ? `${key}-${get("hour")}` : key;
}

export function dayKeyInTz(tz: string, date = new Date()): string {
  return formatInTz(date, tz, false);
}

export function hourKeyInTz(tz: string, date = new Date()): string {
  return formatInTz(date, tz, true);
}

/** 计数器行键：`scope_type|scope_id|period_key`。 */
function counterKey(scopeType: string, scopeId: string, periodKey: string): string {
  return `${scopeType}|${scopeId}|${periodKey}`;
}

export interface BudgetPeriod {
  scopeType: "global" | "job" | "connection_test";
  scopeId: string;
  periodKey: string;
}

/** 一次预留占用的全部计数周期：全局日 + （任务总额 / 连接测试小时）。 */
export function budgetPeriodsFor(
  scopeType: AiScopeType,
  scopeId: string,
  limits: BudgetLimits,
  date = new Date(),
): BudgetPeriod[] {
  const periods: BudgetPeriod[] = [
    { scopeType: "global", scopeId: "*", periodKey: dayKeyInTz(limits.dayTimezone, date) },
  ];
  if (scopeType === "job") {
    periods.push({ scopeType: "job", scopeId, periodKey: "total" });
  }
  if (scopeType === "connection_test") {
    periods.push({
      scopeType: "connection_test",
      scopeId: "*",
      periodKey: hourKeyInTz(limits.dayTimezone, date),
    });
  }
  return periods;
}

function limitFor(period: BudgetPeriod, limits: BudgetLimits): number | null {
  if (period.scopeType === "global" && period.periodKey.includes("-")) return limits.maxCallsPerDay;
  if (period.scopeType === "job" && period.periodKey === "total") return limits.maxCallsPerJob;
  if (period.scopeType === "connection_test") return limits.connectionTestLimitPerHour;
  return null;
}

function incrementCounter(db: DatabaseSync, period: BudgetPeriod): void {
  db.prepare(
    `INSERT INTO ai_budget_counters (scope_type, scope_id, period_key, used) VALUES (?,?,?,1)
     ON CONFLICT(scope_type, scope_id, period_key) DO UPDATE SET used = used + 1`,
  ).run(period.scopeType, period.scopeId, period.periodKey);
}

function decrementCounter(db: DatabaseSync, scopeType: string, scopeId: string, periodKey: string): void {
  db.prepare(
    `UPDATE ai_budget_counters SET used = MAX(0, used - 1)
     WHERE scope_type=? AND scope_id=? AND period_key=?`,
  ).run(scopeType, scopeId, periodKey);
}

export function getBudgetUsage(
  db: DatabaseSync,
  opts: { scopeType?: string; scopeId?: string; periodKey?: string } = {},
): number {
  const where: string[] = [];
  const values: (string | number)[] = [];
  if (opts.scopeType) {
    where.push("scope_type=?");
    values.push(opts.scopeType);
  }
  if (opts.scopeId) {
    where.push("scope_id=?");
    values.push(opts.scopeId);
  }
  if (opts.periodKey) {
    where.push("period_key=?");
    values.push(opts.periodKey);
  }
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(used), 0) AS total FROM ai_budget_counters ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`,
    )
    .get(...values) as { total: number };
  return r.total;
}

/**
 * 原子预留：在单条短事务内检查所有限额并写入调用记录与计数。
 * 超限抛 AiBudgetError（本地拒绝，不请求服务商）。返回预留记录。
 */
export function reserveAiCall(
  db: DatabaseSync,
  input: NewAiCallInput,
  limits: BudgetLimits,
  date = new Date(),
): AiCallRecord {
  db.exec("BEGIN IMMEDIATE");
  try {
    const job = input.exhibitionId && input.purpose !== "connection_test"
      ? ensureCurationJob(db, input.exhibitionId, limits.maxCallsPerJob) : null;
    const periods = budgetPeriodsFor(job ? "job" : input.scopeType, job?.id ?? input.scopeId, limits, date);
    for (const p of periods) {
      const limit = p.scopeType === "job" && job ? Math.min(job.max_calls, limits.maxCallsPerJob) : limitFor(p, limits);
      if (limit == null) continue;
      const used = getBudgetUsage(db, { scopeType: p.scopeType, scopeId: p.scopeId, periodKey: p.periodKey });
      if (used >= limit) {
        db.exec("ROLLBACK");
        throw new AiBudgetError(budgetLimitMessage(p, limit), { periods });
      }
    }
    const record = createAiCall(db, {
      ...input,
      createdAt: date.toISOString(),
      budgetPeriodKeys: periods.map((p) => counterKey(p.scopeType, p.scopeId, p.periodKey)),
    });
    for (const p of periods) incrementCounter(db, p);
    db.exec("COMMIT");
    return record;
  } catch (err) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw err;
  }
}

function budgetLimitMessage(period: BudgetPeriod, limit: number): string {
  if (period.scopeType === "global") {
    return `今日模型调用已达上限（${limit} 次）。请明天再试，或由作者在服务端调整 AI_MAX_CALLS_PER_DAY；已保存的作品不受影响。`;
  }
  if (period.scopeType === "job") {
    return `本影展策展任务的模型调用已达上限（${limit} 次）。已成功的结果保留；跨日、重试、重新生成和调高配置都不会重置已冻结的任务额度。`;
  }
  return `连接测试过于频繁（每小时最多 ${limit} 次），请稍后再试。`;
}

/** 释放未发出的预留并归还名额；已发出的（sent/succeeded/failed）保守占额，不可释放。 */
export function releaseAiReservation(db: DatabaseSync, callId: string): boolean {
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    const rec = getAiCall(db, callId);
    const changed = db.prepare("UPDATE ai_calls SET status='released', finished_at=? WHERE id=? AND status='reserved'")
      .run(new Date().toISOString(), callId).changes;
    if (changed) {
      for (const key of rec?.budget_period_keys ?? []) {
        const [scopeType, scopeId, periodKey] = key.split("|");
        if (scopeType && scopeId && periodKey) decrementCounter(db, scopeType, scopeId, periodKey);
      }
    }
    if (ownsTransaction) db.exec("COMMIT");
    return changed === 1;
  } catch (error) {
    if (ownsTransaction && db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function markAiCallSent(db: DatabaseSync, callId: string): void {
  const changed = db.prepare("UPDATE ai_calls SET status='sent' WHERE id=? AND status='reserved'").run(callId).changes;
  if (changed !== 1) throw new AiBudgetError("调用预留已失效，未向模型发送请求。请检查任务状态。");
}

/** 启动回收：超过宽限期的 reserved 行视为进程中断前未发出，归还名额。 */
export function releaseStaleAiReservations(
  db: DatabaseSync,
  opts: { graceMs?: number; beforeIso?: string } = {},
): number {
  const grace = opts.graceMs ?? 300_000;
  const before = opts.beforeIso ?? new Date(Date.now() - grace).toISOString();
  const rows = db
    .prepare("SELECT id FROM ai_calls WHERE status='reserved' AND created_at < ?")
    .all(before) as unknown as { id: string }[];
  let released = 0;
  for (const r of rows) {
    if (releaseAiReservation(db, r.id)) released += 1;
  }
  return released;
}

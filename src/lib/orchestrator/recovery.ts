import type { DatabaseSync } from "node:sqlite";

/**
 * 执行租约与启动恢复（v3 R03）。
 * 单实例为前提：进程以 owner_id 持有影展级租约并周期心跳；启动时只回收
 * 「已确认失活」（owner 进程不存在）或「心跳过期」的租约，把其 running 行标记为
 * failed + 中断码、影展置 stage_failed（可解释、不新增非法状态值），然后允许重新触发。
 * 活跃执行者（心跳新鲜且进程存活）绝不被回收。
 */

export const INTERRUPTED_CODE = "[interrupted]";
export const FENCED_CODE = "[fenced]";

const LEASE_GRACE_MS = 30_000;
export const HEARTBEAT_MS = 5_000;
const LEASE_TTL_MS = 60_000;

const STAGE_BY_AGENT: Record<string, string> = {
  material_steward: "ingest",
  aesthetic_selector: "select",
  motif_finder: "motifs",
  narrative_editor: "narrative",
  exhibition_designer: "layout",
  curatorial_qa: "qa",
};

const g = globalThis as unknown as {
  __afterlightOwnerId?: string;
  __afterlightHeartbeats?: Map<string, ReturnType<typeof setInterval>>;
};

/** 每个进程一个执行者标识；Next dev 热重载时复用同一标识。 */
export const OWNER_ID: string =
  g.__afterlightOwnerId ?? (g.__afterlightOwnerId = `owner-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);

const heartbeats: Map<string, ReturnType<typeof setInterval>> =
  g.__afterlightHeartbeats ?? (g.__afterlightHeartbeats = new Map());

const iso = (ms: number) => new Date(ms).toISOString();

function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 把影展的 running 行标为中断失败；保留已完成阶段与调用记录。 */
function interruptExhibition(
  db: DatabaseSync,
  exhibitionId: string,
  leaseRunId: string | null,
  nowMs: number,
  workflowId: string | null = null,
): number {
  const rows = db
    .prepare(`SELECT id, agent_type FROM agent_runs WHERE exhibition_id=? AND status='running'
      AND (? IS NULL OR workflow_id=? OR id=?)`)
    .all(exhibitionId, workflowId, workflowId, leaseRunId) as unknown as { id: string; agent_type: string }[];
  if (rows.length === 0) return 0;
  const message = `${INTERRUPTED_CODE} 上一次执行因进程中断未完成，已完成阶段保留；可从失败阶段显式重试。`;
  const stmt = db.prepare(
    "UPDATE agent_runs SET status='failed', error_message=?, finished_at=? WHERE id=? AND status='running'",
  );
  for (const r of rows) stmt.run(message, iso(nowMs), r.id);
  const primary = rows.find((r) => r.id === leaseRunId) ?? rows[0];
  // 若已有其他 workflow 的运行行，旧租约的恢复不能覆盖新执行者的影展状态。
  db.prepare(`UPDATE exhibitions SET status='stage_failed', failed_stage=?, updated_at=? WHERE id=?
    AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE exhibition_id=? AND status='running')`).run(
    STAGE_BY_AGENT[primary.agent_type] ?? null,
    iso(nowMs),
    exhibitionId,
    exhibitionId,
  );
  return rows.length;
}

export interface RecoveryResult {
  reclaimed_leases: number;
  interrupted_runs: number;
}

/**
 * 回收失活租约。includeUnleasedRuns 只在启动时开启：旧版本遗留/崩溃于租约落库前的
 * running 行没有租约，必然失活；运行期触发路径不做此扫描，避免误伤测试/手工行。
 */
export function recoverOrphanedTasks(
  db: DatabaseSync,
  opts: { nowMs?: number; graceMs?: number; includeUnleasedRuns?: boolean } = {},
): RecoveryResult {
  const nowMs = opts.nowMs ?? Date.now();
  const graceMs = opts.graceMs ?? LEASE_GRACE_MS;
  let reclaimed = 0;
  let interrupted = 0;

  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    const leases = db
      .prepare("SELECT exhibition_id, owner_id, run_id, workflow_id, heartbeat_at, expires_at, owner_pid FROM task_leases")
      .all() as unknown as {
        exhibition_id: string;
        owner_id: string;
        run_id: string;
        workflow_id: string;
        heartbeat_at: string;
        expires_at: string;
        owner_pid: number;
      }[];
    for (const l of leases) {
      const expiresAt = Date.parse(l.expires_at);
      const leaseExpired = !Number.isFinite(expiresAt) || expiresAt <= nowMs;
      if (l.owner_id === OWNER_ID && !leaseExpired) continue;
      const hb = Date.parse(l.heartbeat_at);
      const expired = leaseExpired || !Number.isFinite(hb) || nowMs - hb > graceMs;
      const alive = isProcessAlive(l.owner_pid);
      if (alive && !expired) continue;
      interrupted += interruptExhibition(db, l.exhibition_id, l.run_id, nowMs, l.workflow_id);
      db.prepare("DELETE FROM task_leases WHERE exhibition_id=? AND owner_id=? AND run_id=?").run(
        l.exhibition_id, l.owner_id, l.run_id,
      );
      reclaimed++;
    }

    if (opts.includeUnleasedRuns) {
      const orphans = db
        .prepare(
          `SELECT DISTINCT r.exhibition_id AS exhibition_id FROM agent_runs r
            WHERE r.status='running'
              AND NOT EXISTS (SELECT 1 FROM task_leases l WHERE l.exhibition_id=r.exhibition_id)`,
        )
        .all() as unknown as { exhibition_id: string }[];
      for (const o of orphans) {
        interrupted += interruptExhibition(db, o.exhibition_id, null, nowMs);
      }
    }

    if (ownsTransaction) db.exec("COMMIT");
    return { reclaimed_leases: reclaimed, interrupted_runs: interrupted };
  } catch (error) {
    if (ownsTransaction && db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function acquireLease(
  db: DatabaseSync,
  p: { exhibitionId: string; runId: string; workflowId: string },
  opts: { heartbeat?: boolean } = {},
): void {
  const t = Date.now();
  db.prepare(
    `INSERT INTO task_leases
       (exhibition_id, owner_id, owner_pid, run_id, workflow_id, acquired_at, heartbeat_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(exhibition_id) DO UPDATE SET
       owner_id=excluded.owner_id, owner_pid=excluded.owner_pid, run_id=excluded.run_id,
       workflow_id=excluded.workflow_id, acquired_at=excluded.acquired_at,
       heartbeat_at=excluded.heartbeat_at, expires_at=excluded.expires_at`,
  ).run(
    p.exhibitionId,
    OWNER_ID,
    process.pid,
    p.runId,
    p.workflowId,
    iso(t),
    iso(t),
    iso(t + LEASE_TTL_MS),
  );
  if (opts.heartbeat !== false) startHeartbeat(db, p.exhibitionId, p.runId);
}

/** 建 lease 的事务提交后才启动；回滚的 prepare 不留下计时器。 */
export function startHeartbeat(db: DatabaseSync, exhibitionId: string, runId: string): void {
  stopHeartbeat(exhibitionId);
  const timer = setInterval(() => {
    try {
      const t = Date.now();
      const r = db
        .prepare(
          `UPDATE task_leases SET heartbeat_at=?, expires_at=?
            WHERE exhibition_id=? AND owner_id=? AND run_id=?
              AND julianday(expires_at) > julianday(?)`,
        )
        .run(iso(t), iso(t + LEASE_TTL_MS), exhibitionId, OWNER_ID, runId, iso(t));
      if (r.changes === 0) stopHeartbeat(exhibitionId);
    } catch {
      // 数据库在关停过程中被关闭：心跳随之结束
      stopHeartbeat(exhibitionId);
    }
  }, HEARTBEAT_MS);
  timer.unref?.();
  heartbeats.set(exhibitionId, timer);
}

export function stopHeartbeat(exhibitionId: string): void {
  const timer = heartbeats.get(exhibitionId);
  if (timer) {
    clearInterval(timer);
    heartbeats.delete(exhibitionId);
  }
}

/** 发布前 fencing：租约仍由本进程持有，且属于同一 workflow（同一管线内的各阶段共享租约）。 */
export function ensureExecutionOwner(db: DatabaseSync, exhibitionId: string, workflowId: string): boolean {
  const l = db
    .prepare("SELECT owner_id, workflow_id, expires_at FROM task_leases WHERE exhibition_id=?")
    .get(exhibitionId) as { owner_id: string; workflow_id: string; expires_at: string } | undefined;
  return !!l && l.owner_id === OWNER_ID && l.workflow_id === workflowId && Date.parse(l.expires_at) > Date.now();
}

export function releaseLease(db: DatabaseSync, exhibitionId: string, runId: string): void {
  const removed = db.prepare("DELETE FROM task_leases WHERE exhibition_id=? AND owner_id=? AND run_id=?").run(
    exhibitionId,
    OWNER_ID,
    runId,
  );
  // 旧回调不能停止已接替它的新 run 的心跳。
  if (removed.changes > 0) stopHeartbeat(exhibitionId);
}

import type { DatabaseSync } from "node:sqlite";
import { deleteExhibition } from "./repos";

/**
 * 公网匿名会话（AFTERLIGHT_PUBLIC=1 时启用）：无身份概念的临时工牌。
 * Cookie 里的 sid 即会话 ID；数据滑动过期后成套清理。本机版不建行、不清理、行为不变。
 */

const SID_PATTERN = /^sess_[A-Za-z0-9_-]{8,64}$/;

export interface VisitorSession {
  id: string;
  created_at: string;
  last_seen_at: string;
  ai_experience_used: number;
}

export function isVisitorMode(): boolean {
  return process.env.AFTERLIGHT_PUBLIC === "1";
}

export function visitorTtlMinutes(): number {
  const raw = Number(process.env.AFTERLIGHT_VISITOR_TTL_MINUTES);
  return Number.isFinite(raw) && raw >= 5 ? raw : 60;
}

export function visitorAiExperiences(): number {
  const raw = Number(process.env.AFTERLIGHT_VISITOR_AI_EXPERIENCES);
  return Number.isFinite(raw) && raw >= 1 ? raw : 1;
}

export function publicDailyAiExperiences(): number {
  const raw = Number(process.env.AFTERLIGHT_PUBLIC_DAILY_AI_EXPERIENCES);
  return Number.isFinite(raw) && raw >= 1 ? raw : 10;
}

export function visitorAiPhotoCap(): number {
  const raw = Number(process.env.AFTERLIGHT_VISITOR_AI_PHOTOS);
  return Number.isFinite(raw) && raw >= 2 ? raw : 10;
}

/** 校验并取回会话行；不存在时创建（滑动过期：触碰 last_seen_at）。sid 无效返回 null（拒绝而非重签，防伪造）。 */
export function getOrCreateVisitorSession(db: DatabaseSync, sid: string | null, now = new Date()): VisitorSession | null {
  if (!sid || !SID_PATTERN.test(sid)) return null;
  const existing = db.prepare("SELECT * FROM visitor_sessions WHERE id=?").get(sid) as VisitorSession | undefined;
  const stamp = now.toISOString();
  if (existing) {
    db.prepare("UPDATE visitor_sessions SET last_seen_at=? WHERE id=?").run(stamp, sid);
    return { ...existing, last_seen_at: stamp };
  }
  db.prepare("INSERT INTO visitor_sessions (id, created_at, last_seen_at) VALUES (?,?,?)").run(sid, stamp, stamp);
  return { id: sid, created_at: stamp, last_seen_at: stamp, ai_experience_used: 0 };
}

export function markAiExperienceUsed(db: DatabaseSync, sid: string): void {
  db.prepare("UPDATE visitor_sessions SET ai_experience_used=1 WHERE id=?").run(sid);
}

export function hasAiExperience(db: DatabaseSync, sid: string): boolean {
  const row = db.prepare("SELECT ai_experience_used FROM visitor_sessions WHERE id=?").get(sid) as { ai_experience_used: number } | undefined;
  return Boolean(row?.ai_experience_used);
}

/** 今日已启动的访客 AI 体验次数（按会话标记时间近似：用当日启动的访客影展的 curation_jobs 计数）。 */
export function countTodayVisitorExperiences(db: DatabaseSync, dayStartIso: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS c FROM curation_jobs j JOIN exhibitions e ON e.id=j.exhibition_id WHERE e.session_id IS NOT NULL AND j.created_at >= ?",
  ).get(dayStartIso) as { c: number };
  return row.c;
}

export interface PurgeSummary {
  exhibitions: number;
  sessions: number;
}

/** 惰性清理：删除过期会话及其影展（级联清空全部子表），返回成套删除的统计。 */
export function purgeExpiredVisitorData(db: DatabaseSync, dataDir: string, removeUploadDir: (exhibitionId: string) => void, now = new Date()): PurgeSummary {
  const cutoff = new Date(now.getTime() - visitorTtlMinutes() * 60_000).toISOString();
  const expiredSessions = db.prepare("SELECT id FROM visitor_sessions WHERE last_seen_at < ?").all(cutoff) as { id: string }[];
  let exhibitions = 0;
  for (const s of expiredSessions) {
    const rows = db.prepare("SELECT id FROM exhibitions WHERE session_id=?").all(s.id) as { id: string }[];
    for (const r of rows) {
      // 运行中保护：有任务租约或运行态的影展本轮跳过，待下一轮清理。
      const lease = db.prepare("SELECT 1 FROM task_leases WHERE exhibition_id=? LIMIT 1").get(r.id);
      const status = db.prepare("SELECT status FROM exhibitions WHERE id=?").get(r.id) as { status: string } | undefined;
      if (lease || status?.status === "ingesting" || status?.status === "selecting" || status?.status === "writing" || status?.status === "designing" || status?.status === "checking") continue;
      deleteExhibition(db, r.id);
      removeUploadDir(r.id);
      exhibitions += 1;
    }
    db.prepare("DELETE FROM visitor_sessions WHERE id=?").run(s.id);
  }
  return { exhibitions, sessions: expiredSessions.length };
}

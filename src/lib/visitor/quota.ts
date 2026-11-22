import type { DatabaseSync } from "node:sqlite";
import { ApiError } from "@/lib/api/errors";
import { getExhibition } from "@/lib/db/repos";
import { countPhotos } from "@/lib/db/photos";
import { isVisitorMode, visitorAiPhotoCap, publicDailyAiExperiences, hasAiExperience, markAiExperienceUsed, countTodayVisitorExperiences } from "@/lib/db/visitorSessions";
import { resolveVisitorSid } from "@/lib/visitor/access";
import type { AiWindow } from "@/lib/ai/schedule";

/**
 * 公网访客 AI 体验额度（三层）：
 * 1. 每会话 1 次（首次启动 AI 分析即锁定；同影展重试不重复消耗）
 * 2. 全局每日 10 次（Asia/Shanghai 日界，防换 Cookie 刷；总闸）
 * 3. 单影展照片 ≤10 张（超出拒绝启动）
 * 仅约束 AI 模式影展；Demo 影展与已开始影展的重试不受影响。
 */

function dayStartIso(now = new Date()): string {
  const shifted = new Date(now.getTime() + 8 * 3600_000);
  const day = shifted.toISOString().slice(0, 10);
  return new Date(`${day}T00:00:00+08:00`).toISOString();
}

export interface AiExperienceGate {
  /** 启动成功后需要标记会话已用体验 */
  shouldMark: boolean;
}

export function assertVisitorAiExperienceStart(db: DatabaseSync, req: Request, exhibitionId: string, window: () => AiWindow): AiExperienceGate {
  if (!isVisitorMode()) return { shouldMark: false };
  const exh = getExhibition(db, exhibitionId);
  if (!exh || exh.mode !== "ai") return { shouldMark: false };
  const sid = resolveVisitorSid(req);
  if (!sid) return { shouldMark: false }; // 无有效会话时由归属守卫负责拒绝

  const jobExists = Boolean(db.prepare("SELECT 1 FROM curation_jobs WHERE exhibition_id=?").get(exhibitionId));
  if (jobExists) return { shouldMark: false }; // 已开始的体验：重试放行，不重复计数

  const win = window();
  if (!win.allowed) {
    throw new ApiError(403, "ai_schedule", win.message + (win.resumeHint ? ` 预计 ${win.resumeHint}。` : ""));
  }
  if (hasAiExperience(db, sid)) {
    throw new ApiError(403, "ai_experience_exhausted", "本会话的真实 AI 体验次数已用完（每次体验 1 个影展）；可以继续创建影展使用本地演示模式，或导出已有作品。");
  }
  const daily = countTodayVisitorExperiences(db, dayStartIso());
  if (daily >= publicDailyAiExperiences()) {
    throw new ApiError(403, "ai_daily_limit", `今日真实 AI 体验名额已用完（每日 ${publicDailyAiExperiences()} 次），明天空闲时段再来体验。`);
  }
  const photos = countPhotos(db, exhibitionId);
  const cap = visitorAiPhotoCap();
  if (photos > cap) {
    throw new ApiError(400, "photo_cap", `AI 体验版一次最多分析 ${cap} 张照片（当前 ${photos} 张），请精选后再开始。`);
  }
  return { shouldMark: true };
}

export function markVisitorAiExperience(db: DatabaseSync, req: Request, exhibitionId: string): void {
  if (!isVisitorMode()) return;
  const sid = resolveVisitorSid(req);
  if (!sid) return;
  const exh = getExhibition(db, exhibitionId);
  if (!exh || exh.mode !== "ai") return;
  markAiExperienceUsed(db, sid);
}

/** 上传磁盘防护：单会话总量 ≤60MB；全站照片总量水位 ≤400MB（平台磁盘 512MB）。 */
export function assertVisitorUploadDiskCap(db: DatabaseSync, req?: Request): void {
  if (!isVisitorMode()) return;
  const watermarkMb = Number(process.env.AFTERLIGHT_DISK_WATERMARK_MB ?? "400");
  const global = db.prepare("SELECT COALESCE(SUM(file_size),0) AS s FROM photo_assets").get() as { s: number };
  if (global.s > watermarkMb * 1024 * 1024) {
    throw new ApiError(503, "disk_full", "站点存储空间已满，请稍后再试或联系作者清理。");
  }
  const sid = req ? resolveVisitorSid(req) : null;
  if (!sid) return;
  const own = db.prepare(
    "SELECT COALESCE(SUM(p.file_size),0) AS s FROM photo_assets p JOIN exhibitions e ON e.id=p.exhibition_id WHERE e.session_id=?",
  ).get(sid) as { s: number };
  if (own.s > 60 * 1024 * 1024) {
    throw new ApiError(403, "session_disk_cap", "本会话上传总量已达上限（60MB）。已生成的影展保留 1 小时，可先导出保存。");
  }
}

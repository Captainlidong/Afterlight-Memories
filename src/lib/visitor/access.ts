import type { DatabaseSync } from "node:sqlite";
import { ApiError } from "@/lib/api/errors";
import { getExhibition } from "@/lib/db/repos";
import { getOrCreateVisitorSession, isVisitorMode, visitorTtlMinutes } from "@/lib/db/visitorSessions";
import { isValidVisitorSid, readVisitorSid, visitorSetCookie } from "./cookie";

/**
 * 路由侧会话访问层（Node 运行时）：公网模式下校验会话与影展归属。
 * 本机模式（未设 AFTERLIGHT_PUBLIC）全部直接放行，行为与历史版本一致。
 */

export interface VisitorContext {
  sid: string;
  /** 新会话需要通过响应 Set-Cookie 下发 */
  setCookie: string | null;
}

function requestIsSecure(req: Request): boolean {
  // 公网部署常见两种形态：直连 http://IP（Secure 必须为 false，否则浏览器丢弃 Cookie）与 HTTPS 反代（读取转发头）
  if (req.headers.get("x-forwarded-proto") === "https") return true;
  try { return new URL(req.url).protocol === "https:"; } catch { return false; }
}

export function visitorCookieHeader(sid: string, req: Request): string {
  return visitorSetCookie(sid, visitorTtlMinutes() + 5, requestIsSecure(req));
}

/** 从请求解析会话；不存在/无效返回 null（由调用方决定 401 或创建）。 */
export function resolveVisitorSid(req: Request): string | null {
  const sid = readVisitorSid(req);
  return isValidVisitorSid(sid) ? sid : null;
}

/** 读路径归属校验：影展不存在或不属于本会话 → 404（不暴露存在性）。本机模式跳过。 */
export function requireVisitorRead(db: DatabaseSync, req: Request, exhibitionId: string): void {
  if (!isVisitorMode()) return;
  const sid = resolveVisitorSid(req);
  if (!sid) throw new ApiError(404, "not_found", "影展不存在。");
  const exh = getExhibition(db, exhibitionId);
  if (!exh || exh.session_id !== sid) throw new ApiError(404, "not_found", "影展不存在。");
}

/** RSC 页面用：按会话判定归属（本机模式恒为 true）。 */
export function visitorOwnsExhibition(db: DatabaseSync, sid: string | null, exhibitionId: string): boolean {
  if (!isVisitorMode()) return true;
  if (!isValidVisitorSid(sid)) return false;
  const exh = getExhibition(db, exhibitionId);
  return Boolean(exh && exh.session_id === sid);
}

/** 写路径归属校验：同上，并返回会话上下文。 */
export function requireVisitorMutation(db: DatabaseSync, req: Request, exhibitionId: string): VisitorContext {
  if (!isVisitorMode()) return { sid: "", setCookie: null };
  const sid = resolveVisitorSid(req);
  if (!sid) throw new ApiError(401, "invalid_session", "请刷新页面后再操作。");
  const session = getOrCreateVisitorSession(db, sid);
  if (!session) throw new ApiError(401, "invalid_session", "请刷新页面后再操作。");
  const exh = getExhibition(db, exhibitionId);
  if (!exh || exh.session_id !== sid) throw new ApiError(404, "not_found", "影展不存在。");
  return { sid, setCookie: null };
}

/** 创建影展时解析（或新建）会话：返回会话 ID 与需要下发的 Cookie。 */
export function resolveVisitorSessionForCreate(db: DatabaseSync, req: Request): VisitorContext {
  if (!isVisitorMode()) return { sid: "", setCookie: null };
  let sid = resolveVisitorSid(req);
  let setCookie: string | null = null;
  if (!sid) {
    sid = mintSid();
    setCookie = visitorCookieHeader(sid, req);
  }
  getOrCreateVisitorSession(db, sid);
  return { sid, setCookie };
}

function mintSid(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return "sess_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

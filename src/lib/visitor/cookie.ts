/** 公网匿名会话（AFTERLIGHT_PUBLIC=1）：Cookie 即临时工牌，无身份、无注册。本机版不启用。
 *  仅用 Web Crypto（edge/node 通用），保持可在 Proxy 中使用。 */

export const VISITOR_COOKIE = "afterlight_sid";
const SID_PREFIX = "sess_";

export function isPublicVisitorMode(): boolean {
  return process.env.AFTERLIGHT_PUBLIC === "1";
}

export function mintVisitorSid(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return SID_PREFIX + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function readVisitorSid(req: Request): string | null {
  const cookie = req.headers.get("cookie") ?? "";
  const pair = cookie.split(/;\s*/).find((c) => c.startsWith(`${VISITOR_COOKIE}=`));
  return pair ? decodeURIComponent(pair.slice(VISITOR_COOKIE.length + 1)) : null;
}

export function isValidVisitorSid(sid: string | null | undefined): sid is string {
  return typeof sid === "string" && /^sess_[A-Za-z0-9_-]{8,64}$/.test(sid);
}

/** Set-Cookie 值；滑动过期由服务端续期，Cookie 本身给足寿命避免频繁重签。 */
export function visitorSetCookie(sid: string, ttlMinutes: number, secure: boolean): string {
  const parts = [
    `${VISITOR_COOKIE}=${encodeURIComponent(sid)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(300, Math.round(ttlMinutes * 60))}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * 幂等请求 ID（客户端）：优先 crypto.randomUUID；
 * 非 HTTPS 部署（如 IP+HTTP 的公网演示站）下浏览器无该 API，
 * 回退用 crypto.getRandomValues 手工拼 v4 格式——该 API 在非安全环境同样可用。
 */
export function requestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

import { ApiError } from "./errors";
import { isPublicVisitorMode, isValidVisitorSid, VISITOR_COOKIE } from "@/lib/visitor/cookie";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const LOCAL_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function assertLocalMutation(req: Request): void {
  const mode = process.env.AFTERLIGHT_ACCESS_MODE?.trim() || "local";
  if (mode !== "local") {
    throw new ApiError(403, "local_only", "当前版本仅支持本地作者运行，公开写入与连接测试尚未开放。");
  }
  const url = new URL(req.url);
  const headers = req.headers;
  // NextURL 会把回环 IP 改成 localhost；真实 Origin 必须对照已校验的原始 Host。
  const host = headers.get("host") ?? url.host;
  const validHost = [...LOOPBACK].some((name) => host === `${name}${url.port ? `:${url.port}` : ""}`);
  const peer = headers.get("x-forwarded-for");
  const forwardedHost = headers.get("x-forwarded-host");
  const forwardedProto = headers.get("x-forwarded-proto");
  // Next 会为直连请求补转发头；仅接受与回环绑定一致的单跳信息，不信任外部代理链。
  if (!LOOPBACK.has(url.hostname) ||
    !validHost ||
    headers.get("origin") !== `${url.protocol}//${host}` ||
    (headers.has("sec-fetch-site") && headers.get("sec-fetch-site") !== "same-origin") ||
    headers.has("forwarded") ||
    (peer !== null && !LOCAL_PEERS.has(peer)) ||
    (forwardedHost !== null && forwardedHost !== host) ||
    (forwardedProto !== null && forwardedProto !== url.protocol.slice(0, -1))) {
    throw new ApiError(403, "untrusted_origin", "写入只允许来自本机同源页面。请用回环地址打开页面，不要通过外部代理访问。");
  }
}

function firstForwarded(value: string | null): string | null {
  return value === null ? null : value.split(",")[0].trim();
}

/**
 * 公网访客写守卫（AFTERLIGHT_PUBLIC=1）：有效会话 Cookie + 同源校验。
 * 同源校验的可信前提：请求未经不可信代理改写转发头。边缘代理形态（AFTERLIGHT_PROXY_TOKEN
 * 已设置）下，请求由持令牌的边缘函数转发，网关层已完成同源校验，且函数收到的
 * x-forwarded-host 为平台内部主机名——此时 Origin 比对不可靠，令牌门即信任边界，
 * 跳过同源比对（会话归属校验仍由具体路由完成）。未设令牌的直连形态照常比对。
 */
export function assertVisitorApiMutation(req: Request): { sid: string } {
  if (!isPublicVisitorMode()) {
    throw new ApiError(403, "local_only", "当前版本仅支持本地作者运行。");
  }
  const url = new URL(req.url);
  const headers = req.headers;
  const sid = readCookie(headers.get("cookie"), VISITOR_COOKIE);
  if (!isValidVisitorSid(sid)) {
    throw new ApiError(401, "invalid_session", "请刷新页面后再操作。");
  }
  const tokenActive = Boolean(process.env.AFTERLIGHT_PROXY_TOKEN?.trim());
  if (!tokenActive) {
    const host = firstForwarded(headers.get("x-forwarded-host")) ?? headers.get("host") ?? url.host;
    const proto = firstForwarded(headers.get("x-forwarded-proto")) ?? url.protocol.replace(/:$/, "");
    const origin = headers.get("origin");
    if (!origin || origin !== `${proto}://${host}`) {
      throw new ApiError(403, "untrusted_origin", "写入只允许来自本站页面。请通过站点页面正常操作。");
    }
  }
  return { sid };
}

function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  const pair = cookieHeader.split(/;\s*/).find((c) => c.startsWith(`${name}=`));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : null;
}

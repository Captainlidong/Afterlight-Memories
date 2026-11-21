import { ApiError } from "./errors";

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

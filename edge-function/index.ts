/**
 * 留影 Afterlight — Qoder Sites 边缘代理函数（零依赖，Deno.serve）。
 *
 * 职责：把本站 `/functions/v1/app/*` 请求原样转发到作者自有服务器上的创作层
 * （地址存于应用 Secret AFTERLIGHT_ORIGIN_URL）。浏览器全程只见 Qoder Sites
 * 域名——服务器 IP 永不出现在地址栏、页面、网络面板或任何前端产物中。
 *
 * 请求头：透传 Cookie / Origin / Content-Type（访客会话与同源守卫依赖）；
 *   设置 x-forwarded-host / x-forwarded-proto 还原站点地址（源站
 *   assertVisitorApiMutation 同源校验与 Secure Cookie 均依据这两个头）。
 * 可选加固：Secret AFTERLIGHT_PROXY_TOKEN 存在时附带 X-Afterlight-Proxy 头，
 *   源站校验通过才受理——直连源站的裸请求一律 403。
 * 响应：状态码与安全相关头（Set-Cookie / Content-Type / Content-Disposition /
 *   Cache-Control）原样回传，逐跳头剥离；body 流式转发（导出大文件不落地）。
 *
 * 部署：本目录由 Qoder Sites 的 prepare_site(functionDirectory) 打包，
 *   入口必须是 index.ts 的 Deno.serve；相对导入需带显式扩展名。
 */
import { normalizeFunctionPath } from "./proxyPath.ts";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  const originUrl = (Deno.env.get("AFTERLIGHT_ORIGIN_URL") ?? "").trim().replace(/\/+$/, "");
  if (!originUrl) {
    return json(503, {
      error: { code: "service_not_configured", message: "创作层地址未配置，站点暂时不可用。" },
    });
  }

  const incoming = new URL(req.url);
  const upstream = `${originUrl}${normalizeFunctionPath(incoming.pathname)}${incoming.search}`;

  const headers = new Headers();
  for (const [name, value] of req.headers) {
    const lower = name.toLowerCase();
    if (!HOP_BY_HOP.has(lower) && !lower.startsWith("x-qoder-")) headers.set(name, value);
  }
  headers.set("x-forwarded-host", headers.get("x-forwarded-host") ?? incoming.host);
  headers.set("x-forwarded-proto", headers.get("x-forwarded-proto") ?? incoming.protocol.replace(/:$/, ""));
  const token = (Deno.env.get("AFTERLIGHT_PROXY_TOKEN") ?? "").trim();
  if (token) headers.set("x-afterlight-proxy", token);

  let upstreamRes: Response;
  try {
    // AbortSignal.timeout 需较新运行时；不支持时不设超时（转发语义不受影响）。
    const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(120_000) : undefined;
    upstreamRes = await fetch(upstream, {
      method: req.method,
      headers,
      body: req.body,
      redirect: "manual",
      ...(signal ? { signal } : {}),
    });
  } catch {
    return json(502, {
      error: { code: "upstream_unreachable", message: "创作层暂时无法访问，请稍后重试。" },
    });
  }

  const resHeaders = new Headers();
  for (const [name, value] of upstreamRes.headers) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && name.toLowerCase() !== "set-cookie") {
      resHeaders.append(name, value);
    }
  }
  // Set-Cookie 逐条透传：Headers 迭代会把多条 Cookie 合并成逗号串导致损坏，
  // 用 getSetCookie() 保留每条的独立性与属性（HttpOnly / SameSite / Secure / Max-Age）。
  for (const cookie of upstreamRes.headers.getSetCookie()) {
    resHeaders.append("set-cookie", cookie);
  }
  return new Response(upstreamRes.body, { status: upstreamRes.status, headers: resHeaders });
});

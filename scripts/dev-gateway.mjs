/**
 * 本机开发用网关模拟器：复刻 edge-function/index.ts 的转发语义（路径归一化 + 转发头），
 * 用于在本机验证 basePath 构建在边缘代理形态下的全链路行为。
 * 严格模式：非 /functions/v1/app 前缀的请求一律 404——模拟真实平台的保留命名空间路由
 * （/api、/storage、/__qoder_auth 等不经函数），暴露任何漏掉 apiUrl 前缀的客户端请求。
 * 用法：GATEWAY_ORIGIN=http://127.0.0.1:3200 node scripts/dev-gateway.mjs （监听 3300）
 * 仅限本机测试，不参与任何部署。
 */
import { createServer } from "node:http";
import { normalizeFunctionPath } from "../edge-function/proxyPath.ts";

const ORIGIN = process.env.GATEWAY_ORIGIN ?? "http://127.0.0.1:3200";
const PORT = Number(process.env.GATEWAY_PORT ?? 3300);
const FUNCTION_PREFIX = "/functions/v1/app";
const HOP_BY_HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade"]);

createServer(async (req, res) => {
  const incoming = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  // 平台路由语义：仅 /functions/v1/app/** 到达函数；其余路径属静态层或保留命名空间（本模拟器不含静态层，一律 404）。
  if (incoming.pathname !== FUNCTION_PREFIX && !incoming.pathname.startsWith(`${FUNCTION_PREFIX}/`)) {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: { code: "outside_function_namespace", message: "非函数前缀路径（模拟平台保留命名空间）" } }));
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(name) && !name.startsWith("x-qoder-")) headers[name] = value;
  }
  headers["x-forwarded-host"] = req.headers.host;
  headers["x-forwarded-proto"] = "http";

  const target = `${ORIGIN}${normalizeFunctionPath(incoming.pathname)}${incoming.search}`;
  try {
    const upstream = await fetch(target, { method: req.method, headers, body, redirect: "manual" });
    const payload = Buffer.from(await upstream.arrayBuffer());
    const outHeaders = {};
    upstream.headers.forEach((value, name) => {
      if (!["content-encoding", "transfer-encoding", "connection"].includes(name)) outHeaders[name] = value;
    });
    res.writeHead(upstream.status, outHeaders);
    res.end(payload);
  } catch {
    res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: { code: "upstream_unreachable", message: "创作层暂时无法访问，请稍后重试。" } }));
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`[dev-gateway] 127.0.0.1:${PORT} -> ${ORIGIN}`);
});

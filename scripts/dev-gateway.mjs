/**
 * 本机开发用网关模拟器：复刻 edge-function/index.ts 的转发语义（路径归一化 + 转发头），
 * 用于在本机验证 basePath 构建在边缘代理形态下的全链路行为。
 * 用法：GATEWAY_ORIGIN=http://127.0.0.1:3200 node scripts/dev-gateway.mjs （监听 3300）
 * 仅限本机测试，不参与任何部署。
 */
import { createServer } from "node:http";
import { normalizeFunctionPath } from "../edge-function/proxyPath.ts";

const ORIGIN = process.env.GATEWAY_ORIGIN ?? "http://127.0.0.1:3200";
const PORT = Number(process.env.GATEWAY_PORT ?? 3300);
const HOP_BY_HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade"]);

createServer(async (req, res) => {
  const incoming = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
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

import { afterEach, describe, expect, it, vi } from "vitest";
import { assertLocalMutation } from "@/lib/api/localRequest";
import { proxy } from "@/proxy";
import { NextRequest } from "next/server";

function request(headers: Record<string, string> = {}, url = "http://localhost:3000/api/ai/connection-test") {
  return new Request(url, { method: "POST", headers: { origin: new URL(url).origin, host: new URL(url).host, ...headers } });
}
afterEach(() => vi.unstubAllEnvs());

describe("本地作者写入口", () => {
  it.each(["localhost", "127.0.0.1", "[::1]"])("接受同源回环 %s", (host) => {
    vi.stubEnv("AFTERLIGHT_ACCESS_MODE", "local");
    expect(() => assertLocalMutation(request({}, `http://${host}:3000/api/ai/connection-test`))).not.toThrow();
  });
  it.each<Record<string, string>>([
    { origin: "https://evil.example" }, { origin: "null" }, { origin: "" },
    { host: "evil.example" }, { "sec-fetch-site": "cross-site" },
    { "x-forwarded-for": "203.0.113.1" }, { "x-forwarded-for": "127.0.0.1, 203.0.113.1" },
    { "x-forwarded-host": "evil.example" }, { "x-forwarded-proto": "https" }, { forwarded: "for=127.0.0.1" },
  ])("拒绝不可信来源 %j", (headers) => {
    expect(() => assertLocalMutation(request(headers))).toThrow();
  });
  it("拒绝伪装本地的网络主机及 public/非法运行模式", () => {
    expect(() => assertLocalMutation(request({}, "http://192.168.1.2:3000/api/test"))).toThrow();
    for (const mode of ["public", "typo"]) {
      vi.stubEnv("AFTERLIGHT_ACCESS_MODE", mode);
      expect(() => assertLocalMutation(request())).toThrow();
    }
  });
  it("接受 Next 的同源回环转发元数据", () => {
    expect(() => assertLocalMutation(request({ "x-forwarded-for": "::ffff:127.0.0.1", "x-forwarded-host": "localhost:3000", "x-forwarded-proto": "http" }))).not.toThrow();
  });
  it.each(["localhost", "127.0.0.1", "[::1]"])("NextRequest 规范化后仍接受同源回环 %s", (host) => {
    vi.stubEnv("AFTERLIGHT_ACCESS_MODE", "local");
    const req = new NextRequest(request({}, `http://${host}:3000/api/test`));
    expect(proxy(req).headers.get("x-middleware-next")).toBe("1");
    expect(() => assertLocalMutation(req)).not.toThrow();
  });
  it.each<Record<string, string>>([
    { origin: "http://localhost:3000" },
    { host: "127.0.0.1:3001", origin: "http://127.0.0.1:3001" },
    { "x-forwarded-host": "localhost:3000" },
  ])("NextRequest 规范化不放宽 Origin、端口或转发 Host %j", (headers) => {
    const req = new NextRequest(request(headers, "http://127.0.0.1:3000/api/test"));
    expect(proxy(req).status).toBe(403);
  });
  it("所有 API 写入经过代理守卫，读取不消耗调用", () => {
    const denied = proxy(new NextRequest(request({ origin: "https://evil.example" }, "http://localhost:3000/api/exhibitions")));
    expect(denied.status).toBe(403);
    const read = proxy(new NextRequest("http://localhost:3000/api/health"));
    expect(read.headers.get("x-middleware-next")).toBe("1");
  });
});

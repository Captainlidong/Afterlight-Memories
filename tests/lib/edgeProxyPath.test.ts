import { describe, expect, it } from "vitest";
import { normalizeFunctionPath } from "../../edge-function/proxyPath";

/** Qoder Sites 网关转发形态不定（完整/剥 /functions/v1/剥逻辑名），代理必须归一化到源站 basePath。 */
describe("边缘代理路径归一化", () => {
  it("完整前缀原样保留", () => {
    expect(normalizeFunctionPath("/functions/v1/app")).toBe("/functions/v1/app");
    expect(normalizeFunctionPath("/functions/v1/app/api/health")).toBe("/functions/v1/app/api/health");
    expect(normalizeFunctionPath("/functions/v1/app/api/exhibitions/e1/photos")).toBe(
      "/functions/v1/app/api/exhibitions/e1/photos",
    );
    expect(normalizeFunctionPath("/functions/v1/app/e/e1")).toBe("/functions/v1/app/e/e1");
  });

  it("剥掉 /functions/v1 的 /app/... 形态补全前缀", () => {
    expect(normalizeFunctionPath("/app")).toBe("/functions/v1/app");
    expect(normalizeFunctionPath("/app/api/health")).toBe("/functions/v1/app/api/health");
    expect(normalizeFunctionPath("/app/create")).toBe("/functions/v1/app/create");
  });

  it("剥掉 /functions/v1 但保留逻辑名之外的部分（/functions/v1/X）补全", () => {
    expect(normalizeFunctionPath("/functions/v1/api/health")).toBe("/functions/v1/app/api/health");
  });

  it("逻辑名也被剥掉的裸业务路径补全前缀", () => {
    expect(normalizeFunctionPath("/api/ai/status")).toBe("/functions/v1/app/api/ai/status");
    expect(normalizeFunctionPath("/api/exhibitions/e1/curation/confirm")).toBe(
      "/functions/v1/app/api/exhibitions/e1/curation/confirm",
    );
    expect(normalizeFunctionPath("/create")).toBe("/functions/v1/app/create");
    expect(normalizeFunctionPath("/e/e1")).toBe("/functions/v1/app/e/e1");
    expect(normalizeFunctionPath("/demo/photos/p1.jpg")).toBe("/functions/v1/app/demo/photos/p1.jpg");
    expect(normalizeFunctionPath("/_next/static/chunk.js")).toBe("/functions/v1/app/_next/static/chunk.js");
  });

  it("物理函数名形态（生产 canonical：308 目标实测）剥离物理段", () => {
    const physical = "/app-d01a203d2eff37b4ea9121344d260bce3";
    expect(normalizeFunctionPath(`/functions/v1/app${physical}/api/health`)).toBe("/functions/v1/app/api/health");
    expect(normalizeFunctionPath(`/functions/v1/app${physical}`)).toBe("/functions/v1/app");
    expect(normalizeFunctionPath(`/functions/v1/app${physical}/demo/photos/p01.jpg`)).toBe(
      "/functions/v1/app/demo/photos/p01.jpg",
    );
    expect(normalizeFunctionPath(`${physical}/api/health`)).toBe("/functions/v1/app/api/health");
    expect(normalizeFunctionPath(`/functions/v1${physical}/api/health`)).toBe("/functions/v1/app/api/health");
  });

  it("根路径与空路径指向应用根（源站 basePath 重定向/首页）", () => {
    expect(normalizeFunctionPath("/")).toBe("/functions/v1/app");
    expect(normalizeFunctionPath("")).toBe("/functions/v1/app");
  });

  it("业务路由不会与剥离段歧义（应用没有 /app、/functions 开头的路由）", () => {
    // 防回归：若未来新增此类路由，必须回改归一化规则。
    expect(normalizeFunctionPath("/api/...")).not.toBe("/api/...");
  });
});

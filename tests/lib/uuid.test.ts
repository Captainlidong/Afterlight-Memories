import { afterEach, describe, expect, it, vi } from "vitest";
import { requestId } from "@/lib/uuid";

/** 公网 HTTP 部署回归：非安全环境下 crypto.randomUUID 不存在，幂等请求 ID 必须有兼容回退。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("幂等请求 ID 兼容回退", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("安全环境：直接使用 crypto.randomUUID", () => {
    expect(requestId()).toMatch(UUID_RE);
  });

  it("非安全环境（randomUUID 缺失）：getRandomValues 回退生成合法 v4 格式", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
        return arr;
      },
    });
    const a = requestId();
    const b = requestId();
    expect(a).toMatch(UUID_RE);
    expect(b).toMatch(UUID_RE);
    expect(a).not.toBe(b);
  });

  it("连续生成不重复", () => {
    const ids = new Set(Array.from({ length: 100 }, () => requestId()));
    expect(ids.size).toBe(100);
  });
});

import { describe, expect, it } from "vitest";
import { statusPollingOptions } from "@/lib/hooks";
import type { StatusPayload } from "@/lib/hooks";

/**
 * §19.2 B 自动前进的可靠性地基：
 * 1. 后台标签页仍继续轮询（SWR 默认 refreshWhenHidden=false，切走即停 → 看不到终态）。
 * 2. 配置必须每次返回新引用：SWR 轮询 effect 依赖 refreshInterval 函数标识，
 *    稳定引用会让 effect 只在挂载时跑一次（此时 is_running=false →  interval 0），
 *    之后 is_running 变 true 也永不启动轮询（浏览器实测复现）。
 */
describe("statusPollingOptions", () => {
  it("后台标签页仍继续轮询（refreshWhenHidden=true）", () => {
    expect(statusPollingOptions().refreshWhenHidden).toBe(true);
  });

  it("运行中 800ms 轮询，空闲停止", () => {
    const { refreshInterval } = statusPollingOptions();
    expect(refreshInterval({ is_running: true } as StatusPayload)).toBe(800);
    expect(refreshInterval({ is_running: false } as StatusPayload)).toBe(0);
    expect(refreshInterval(undefined)).toBe(0);
  });

  it("每次调用返回新的 refreshInterval 引用（SWR 动态启停轮询的前提）", () => {
    expect(statusPollingOptions().refreshInterval).not.toBe(statusPollingOptions().refreshInterval);
  });
});
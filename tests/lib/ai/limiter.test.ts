import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireAiSlot, AI_QUEUE_LIMIT, AI_QUEUE_WAIT_MS, getAiActivity } from "@/lib/ai/limiter";
import { loadAiConfig } from "@/lib/ai/config";

const config = () => loadAiConfig({ NODE_ENV: "test", AI_API_KEY: "fake-limiter-key",
  AI_BASE_URL: "https://limiter.invalid/v1", AI_VISION_MODEL: "synthetic", AI_MAX_CONCURRENCY: "1" });
afterEach(() => { vi.useRealTimers(); });

describe("单进程共享 HTTP 槽", () => {
  it("实时排队与在途按影展和 workflow 隔离，取消/释放后归零", async () => {
    const a = { exhibitionId: "a", workflowId: "w1" };
    const b = { exhibitionId: "a", workflowId: "w2" };
    const bounds = { maxQueued: AI_QUEUE_LIMIT, waitMs: AI_QUEUE_WAIT_MS };
    const release = await acquireAiSlot(config(), undefined, bounds, a);
    const controller = new AbortController();
    const queued = acquireAiSlot(config(), controller.signal, bounds, b) as Promise<() => void>;
    const rejected = expect(queued).rejects.toMatchObject({ cls: "cancelled" });
    expect(getAiActivity(config(), a)).toEqual({ queued: 0, in_flight: 1 });
    expect(getAiActivity(config(), b)).toEqual({ queued: 1, in_flight: 0 });
    controller.abort();
    await rejected;
    expect(getAiActivity(config(), b)).toEqual({ queued: 0, in_flight: 0 });
    release();
    expect(getAiActivity(config(), a)).toEqual({ queued: 0, in_flight: 0 });
    expect(getAiActivity({ ...config(), baseUrl: null }, a)).toEqual({ queued: 0, in_flight: 0 });
  });
  it("FIFO、幂等释放；取消队首不阻塞后来者", async () => {
    const release = await acquireAiSlot(config());
    const cancel = new AbortController();
    const first = acquireAiSlot(config(), cancel.signal) as Promise<() => void>;
    const rejected = expect(first).rejects.toMatchObject({ cls: "cancelled" });
    const granted: number[] = [];
    const second = Promise.resolve(acquireAiSlot(config())).then((r) => { granted.push(2); return r; });
    const third = Promise.resolve(acquireAiSlot(config())).then((r) => { granted.push(3); return r; });
    cancel.abort("not-logged");
    await rejected;
    release(); release();
    const releaseSecond = await second;
    expect(granted).toEqual([2]);
    releaseSecond();
    (await third)();
    expect(granted).toEqual([2, 3]);
  });

  it("100 个排队上限与 30 秒等待期限，拒绝后可以重新使用", async () => {
    vi.useFakeTimers();
    const release = await acquireAiSlot(config());
    const pending = Array.from({ length: AI_QUEUE_LIMIT }, () => Promise.resolve(acquireAiSlot(config())));
    const all = Promise.allSettled(pending);
    expect(() => acquireAiSlot(config())).toThrowError(/队列/);
    await vi.advanceTimersByTimeAsync(AI_QUEUE_WAIT_MS);
    expect((await all).every((r) => r.status === "rejected" && r.reason.cls === "queue")).toBe(true);
    release();
    (await acquireAiSlot(config()))();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("已取消请求不拿槽，等待取消清理 timer", async () => {
    vi.useFakeTimers();
    const signal = AbortSignal.abort(new Error("private reason"));
    expect(() => acquireAiSlot(config(), signal)).toThrowError(/取消/);
    const release = await acquireAiSlot(config());
    const controller = new AbortController();
    const queued = acquireAiSlot(config(), controller.signal) as Promise<() => void>;
    const rejected = expect(queued).rejects.toMatchObject({ cls: "cancelled" });
    controller.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    release();
  });

  it("同服务旧快照的不同并发配置不能另开独立池", async () => {
    const release = await acquireAiSlot(config());
    let entered = false;
    const queued = Promise.resolve(acquireAiSlot({ ...config(), maxConcurrency: 2, textModel: "other", maxRetries: 3 }))
      .then((r) => { entered = true; return r; });
    await Promise.resolve();
    expect(entered).toBe(false);
    release();
    (await queued)();
  });
});

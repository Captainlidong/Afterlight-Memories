import { canonicalDigest } from "./cache";
import type { AiConfig } from "./config";
import { AiCancelledError, AiQueueError } from "./errors";

/** 只作内部索引，禁止输出该摘要或原始配置。模型/重试/DB/transport 不改变服务身份。 */
export function serviceIdentity(config: AiConfig): string {
  const url = new URL(config.baseUrl!);
  url.pathname = url.pathname.replace(/\/+$/, "");
  return canonicalDigest([config.provider, url.href, config.apiKey]);
}

export const AI_QUEUE_LIMIT = 100;
export const AI_QUEUE_WAIT_MS = 30_000;
type Release = () => void;
export interface AiActivityScope { exhibitionId: string | null; workflowId?: string | null }
interface Waiter { grant: (release: Release) => void; cleanup: () => void; scopeKey: string | null }
interface Pool { active: number; limit: number; queue: Waiter[]; activeByScope: Map<string, number> }
// 进程共享，与合并请求使用的 DB/transport WeakMap 无关；空闲立即清理。
// 路由打包/开发热更新重新求值模块时，同进程仍共享限制与状态。
const shared = globalThis as typeof globalThis & { __afterlightAiPools?: Map<string, Pool> };
const pools = shared.__afterlightAiPools ??= new Map<string, Pool>();
const activityKey = (scope?: AiActivityScope): string | null => scope
  ? JSON.stringify([scope.exhibitionId, scope.workflowId ?? null]) : null;

/** 只返回当前进程的实时计数，绝不把内部服务/密钥摘要返回页面。 */
export function getAiActivity(config: AiConfig, scope: AiActivityScope) {
  const pool = config.baseUrl ? pools.get(serviceIdentity(config)) : undefined;
  const key = activityKey(scope);
  return {
    queued: pool?.queue.filter(waiter => waiter.scopeKey === key).length ?? 0,
    in_flight: key ? pool?.activeByScope.get(key) ?? 0 : 0,
  };
}

export function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AiCancelledError();
}

/** 立即获槽时同步返回，保证检查/预留/sent 之间没有额外异步间隙。 */
export function acquireAiSlot(config: AiConfig, signal?: AbortSignal,
  bounds = { maxQueued: AI_QUEUE_LIMIT, waitMs: AI_QUEUE_WAIT_MS },
  scope?: AiActivityScope): Release | Promise<Release> {
  assertNotCancelled(signal);
  const key = serviceIdentity(config);
  let pool = pools.get(key);
  if (!pool) {
    pool = { active: 0, limit: config.maxConcurrency, queue: [], activeByScope: new Map() };
    pools.set(key, pool);
  }
  const state = pool;
  // 同服务存在不同快照时取保守上限，不另建池绕过；已有请求不强行中断。
  state.limit = Math.min(state.limit, config.maxConcurrency);
  const clean = () => {
    if (state.active === 0 && state.queue.length === 0) pools.delete(key);
  };
  const grant = (scopeKey: string | null): Release => {
    state.active++;
    if (scopeKey) state.activeByScope.set(scopeKey, (state.activeByScope.get(scopeKey) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.active--;
      if (scopeKey) {
        const remaining = (state.activeByScope.get(scopeKey) ?? 1) - 1;
        if (remaining) state.activeByScope.set(scopeKey, remaining);
        else state.activeByScope.delete(scopeKey);
      }
      while (state.active < state.limit && state.queue.length) {
        const next = state.queue.shift()!;
        next.cleanup();
        next.grant(grant(next.scopeKey));
      }
      clean();
    };
  };
  const scopeKey = activityKey(scope);
  if (state.active < state.limit && state.queue.length === 0) return grant(scopeKey);
  if (state.queue.length >= bounds.maxQueued) throw new AiQueueError();
  return new Promise<Release>((resolve, reject) => {
    const remove = (error: Error) => {
      const index = state.queue.indexOf(waiter);
      if (index === -1) return;
      state.queue.splice(index, 1);
      waiter.cleanup();
      clean();
      reject(error);
    };
    const abort = () => remove(new AiCancelledError());
    const timer = setTimeout(() => remove(new AiQueueError()), bounds.waitMs);
    const waiter: Waiter = { grant: resolve, scopeKey, cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    } };
    state.queue.push(waiter);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** 用于合并等待、退避及响应流；不取消被其他调用者共享的源 Promise。 */
export function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => { cleanup(); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

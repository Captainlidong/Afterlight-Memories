import type { DatabaseSync } from "node:sqlite";
import { ZodError } from "zod";
import { assertUsable, chatCompletionsUrl, type AiConfig } from "./config";
import {
  AiError,
  AiBusinessValidationError,
  AiCancelledError,
  AiConfigError,
  AiInvalidResponseError,
  AiNetworkError,
  AiProviderAuthError,
  AiProviderError,
  AiProviderQuotaError,
  AiTimeoutError,
  AiTransientError,
  backoffMs,
  desensitize,
  parseRetryAfter,
} from "./errors";
import { cacheDeleteEntry, cacheGetEntry, cacheSave, canonicalDigest, type CacheEntry, type CacheLookupInput } from "./cache";
import { markAiCallSent, releaseAiReservation, reserveAiCall, type BudgetLimits } from "./budget";
import { acquireAiSlot, AI_QUEUE_LIMIT, AI_QUEUE_WAIT_MS, assertNotCancelled, serviceIdentity, waitWithSignal } from "./limiter";
import { AI_ERROR_GUIDANCE } from "./feedback";
import { updateAiCall, type AiCallStatus } from "./records";
import { assertExternalSendAllowed, type AiCallContext } from "./policy";
import type { AiChatMessage, AiUsage } from "./schemas";

/**
 * 唯一模型调用入口（任务书 v3 §3.2 / §7）：真实调用集中在此，四个 adapter 不各写重试与预算。
 * 流程：服务端守卫 → 授权检查（每次读库）→ 配置可用 → 缓存命中/并发合并
 *       → 原子预留预算 → 带超时 fetch → 有界重试（仅 429/5xx，尊重 Retry-After）
 *       → 结构解析 → usage/request_id 记账（脱敏）→ 校验成功后写缓存。
 * transport 可注入，测试用 Mock，绝不使用作者 Key。
 */

export type AiTransport = (url: string, init: RequestInit) => Promise<Response>;

export interface AiRunOptions<T> {
  context: AiCallContext;
  /** 本模型服务商请求头字段模型 ID（调用方用 config 选定）。 */
  model: string;
  messages: AiChatMessage[];
  /** 期望输出上限，实际以服务端 AI_MAX_OUTPUT_TOKENS 封顶。 */
  maxTokens: number;
  /** Zod 解析；失败按 invalid_response 处理（不落库、不缓存、不覆盖原作品）。 */
  parse: (content: string) => T;
  /** 参与缓存键的输入摘要与键；缺省时用 messages 摘要且不缓存。 */
  cacheKey?: string;
  inputDigest?: string;
  signal?: AbortSignal;
  /** 生产调用方重读当前配置；变化时拒绝旧请求，不静默换服务发送。 */
  getCurrentConfig?: () => AiConfig;
}

export interface AiRunResult<T> {
  data: T;
  /** fresh=本次真实外发；cache=使用已有分析，本次未重新发送（§7.2）。 */
  source: "fresh" | "cache";
  /** 产生结果的真实调用 ID；旧缓存未记录来源时为 null。 */
  callId: string | null;
}

const defaultTransport: AiTransport = (url, init) =>
  fetch(url, { ...init, redirect: "manual" });

type InFlightCalls = Map<string, Promise<AiRunResult<unknown>>>;

// 仅同一 DB 对象、同一 transport 函数可共享；弱引用避免保留已关闭的 DB 或测试 Mock。
const inFlightByDb = new WeakMap<DatabaseSync, WeakMap<AiTransport, InFlightCalls>>();

function inFlightFor(db: DatabaseSync, transport: AiTransport): InFlightCalls {
  let byTransport = inFlightByDb.get(db);
  if (!byTransport) {
    byTransport = new WeakMap();
    inFlightByDb.set(db, byTransport);
  }
  let calls = byTransport.get(transport);
  if (!calls) {
    calls = new Map();
    byTransport.set(transport, calls);
  }
  return calls;
}

/** 服务商响应大小上限（§7.1）：超限按 invalid_response 处理，不落库不缓存。 */
const MAX_RESPONSE_BYTES = 1_000_000;

function isFormatError(err: unknown): boolean {
  return err instanceof ZodError || err instanceof SyntaxError || err instanceof AiInvalidResponseError;
}

/** 包括无长度头的 chunked 响应；按收到的字节计数，超限/取消立即 cancel。 */
async function readBoundedBody(res: Response, signal: AbortSignal): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  let complete = false;
  try {
    const length = Number(res.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new AiInvalidResponseError();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const chunk = await waitWithSignal(reader.read(), signal);
      if (chunk.done) { complete = true; break; }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new AiInvalidResponseError();
      chunks.push(chunk.value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(body); }
    catch { throw new AiInvalidResponseError(); }
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function extractContent(bodyText: string): string {
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new AiInvalidResponseError("模型返回的不是合法 JSON。");
  }
  const choices = (json as { choices?: unknown } | null)?.choices;
  if (!Array.isArray(choices) || choices.length === 0) throw new AiInvalidResponseError();
  const choice = choices[0];
  if (!choice || typeof choice !== "object" || Array.isArray(choice) ||
    !choice.message || typeof choice.message !== "object" || Array.isArray(choice.message) ||
    (choice.finish_reason !== undefined && choice.finish_reason !== "stop")) {
    throw new AiInvalidResponseError("模型响应不完整或已截断，已丢弃。");
  }
  const content = choice.message.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new AiInvalidResponseError("模型响应缺少可用的文本内容。");
  }
  return content;
}

function extractUsage(bodyText: string): AiUsage | null {
  try {
    const usage = (JSON.parse(bodyText) as { usage?: Record<string, unknown> }).usage;
    if (!usage) return null;
    const pick = (k: string) => (typeof usage[k] === "number" && Number.isFinite(usage[k]) && usage[k] >= 0 ? usage[k] : undefined);
    const out: AiUsage = {};
    const p = pick("prompt_tokens");
    const c = pick("completion_tokens");
    const t = pick("total_tokens");
    if (p !== undefined) out.prompt_tokens = p;
    if (c !== undefined) out.completion_tokens = c;
    if (t !== undefined) out.total_tokens = t;
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

function extractRequestId(res: Response, key: string | null): string | null {
  const id = res.headers.get("x-request-id") ?? res.headers.get("openai-request-id") ?? res.headers.get("x-openai-request-id");
  return id && /^[A-Za-z0-9_-]{1,128}$/.test(id) && (!key || !id.includes(key)) ? id : null;
}

/** 服务商错误归类（§7.4）：只有瞬态错误可自动重试；消息脱敏，不携带服务商原文与密钥。 */
export function classifyProviderError(res: Response, bodyText: string, secrets: string[] = []): AiError {
  const status = res.status;
  const excerpt = desensitize(bodyText.slice(0, 400), secrets);
  const lower = excerpt.toLowerCase();
  if (status === 401 || status === 403) {
    return new AiProviderAuthError(
      "模型服务拒绝访问（密钥无效或没有权限）。请在服务端检查 AI_API_KEY 与模型 ID 配置；演示模式不受影响。",
      status,
    );
  }
  if (status === 402) {
    return new AiProviderQuotaError(
      "模型服务账户余额或配额不足，已停止新增外发。请到服务商控制台检查；已保存的作品不受影响。",
      status,
    );
  }
  if (status === 429) {
    if (lower.includes("insufficient_quota") || lower.includes("billing") || lower.includes("quota exceeded")) {
      return new AiProviderQuotaError(
        "模型服务配额耗尽，已停止新增外发。请到服务商控制台检查；已保存的作品不受影响。",
        status,
      );
    }
    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
    return new AiTransientError("模型服务限流，稍后自动重试。", { status, retryAfterMs });
  }
  if (status === 408 || status >= 500) {
    return new AiTransientError("模型服务暂时不可用，稍后自动重试。", { status });
  }
  if (status >= 300 && status < 400) {
    return new AiProviderError("模型服务返回了重定向，已拒绝跟随，防止请求转发到未知主机。", { status });
  }
  return new AiProviderError("模型服务返回错误。", { status });
}

export class AiClient {
  constructor(
    private readonly db: DatabaseSync,
    private readonly config: AiConfig,
    private readonly transport: AiTransport = defaultTransport,
    private readonly sleepMs: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly nowFn: () => Date = () => new Date(),
  ) {
    this.config = structuredClone(config);
  }

  private get limits(): BudgetLimits {
    return {
      maxCallsPerJob: this.config.maxCallsPerJob,
      maxCallsPerDay: this.config.maxCallsPerDay,
      connectionTestLimitPerHour: this.config.connectionTestLimitPerHour,
      dayTimezone: this.config.dayTimezone,
    };
  }

  private settle(
    callId: string,
    fields: {
      status: AiCallStatus;
      durationMs: number;
      usage?: AiUsage | null;
      providerRequestId?: string | null;
      errorClass?: string | null;
      errorMessage?: string | null;
    },
  ): void {
    updateAiCall(this.db, callId, {
      status: fields.status,
      duration_ms: fields.durationMs,
      usage: fields.usage ?? null,
      provider_request_id: fields.providerRequestId ?? null,
      error_class: fields.errorClass ?? null,
      error_message: fields.errorMessage ?? null,
      finished_at: this.nowFn().toISOString(),
    });
  }

  private cacheVersions(context: AiCallContext) {
    return {
      promptVersion: context.promptVersion,
      schemaVersion: context.schemaVersion,
      preprocessVersion: context.preprocessVersion ?? "none",
    };
  }

  private assertCurrent<T>(opts: AiRunOptions<T>): void {
    assertNotCancelled(opts.signal);
    assertExternalSendAllowed(this.db, opts.context);
    assertUsable(this.config);
    if (opts.getCurrentConfig) {
      const current = opts.getCurrentConfig();
      assertUsable(current);
      // 文本模型变化不能使未变的单图视觉事实失效。
      const relevant = (config: AiConfig) => opts.context.purpose === "vision"
        ? { ...config, textModel: null } : config;
      if (canonicalDigest(relevant(current)) !== canonicalDigest(relevant(this.config))) {
        throw new AiConfigError("模型服务配置已变化，已拒绝旧请求，请重新操作。");
      }
    }
  }

  private cachedResult<T>(entry: CacheEntry, opts: AiRunOptions<T>): AiRunResult<T> {
    try {
      // 只复用数据，不复用另一调用方的业务校验结论。
      const data = opts.parse(JSON.stringify(entry.data));
      this.assertCurrent(opts);
      return { data, source: "cache", callId: entry.callId };
    } catch (err) {
      if (isFormatError(err)) throw new AiInvalidResponseError();
      throw err;
    }
  }

  private lookup<T>(input: CacheLookupInput | null, opts: AiRunOptions<T>): AiRunResult<T> | null {
    if (!input) return null;
    const entry = cacheGetEntry(this.db, input);
    if (!entry) return null;
    try { return this.cachedResult(entry, opts); }
    catch (error) {
      // 视觉坏结构可补请求；非视觉保留旧的引用复验失败即拒绝语义。
      if (opts.context.purpose !== "vision" || !isFormatError(error)) throw error;
      cacheDeleteEntry(this.db, input);
      return null;
    }
  }

  async run<T>(input: AiRunOptions<T>): Promise<AiRunResult<T>> {
    // 队列中的实际发送输入不能被调用者原地修改。
    const opts = { ...input, context: { ...input.context }, messages: structuredClone(input.messages) };
    this.assertCurrent(opts);
    const vision = opts.context.purpose === "vision";
    const request = { model: opts.model, maxTokens: Math.min(opts.maxTokens, this.config.maxOutputTokens),
      messagesDigest: canonicalDigest(opts.messages) };
    const cacheable = this.config.cacheEnabled && opts.context.purpose !== "connection_test";
    const cacheInput: CacheLookupInput | null = cacheable && opts.cacheKey ? {
      // 表的既有 CHECK 支持 job；审计 context 仍保留实际 workflow。
      scopeType: vision ? "job" : opts.context.scopeType,
      scopeId: vision ? opts.context.exhibitionId! : opts.context.scopeId,
      exhibitionId: opts.context.exhibitionId,
      purpose: opts.context.purpose,
      cacheKey: vision ? canonicalDigest({ version: "vision-cache-v2", key: opts.cacheKey,
        service: serviceIdentity(this.config), request }) : opts.cacheKey,
      provider: this.config.provider,
      model: opts.model,
      ...this.cacheVersions(opts.context),
    } : null;
    const inFlightKey = cacheInput && canonicalDigest({ cache: cacheInput, request,
      ...(vision ? {} : { config: this.config }) });
    let inFlight: InFlightCalls | null = null;
    if (cacheInput && inFlightKey) {
      const hit = this.lookup(cacheInput, opts);
      if (hit) return hit;
      inFlight = inFlightFor(this.db, this.transport);
      const inflight = inFlight.get(inFlightKey);
      if (inflight) {
        let entry: CacheEntry;
        try { entry = await waitWithSignal(inflight, opts.signal); }
        catch (error) { assertNotCancelled(opts.signal); throw error; }
        this.assertCurrent(opts);
        return this.cachedResult(entry, opts);
      }
    }
    const task = this.perform(opts, cacheInput);
    if (inFlightKey) inFlight?.set(inFlightKey, task);
    try { return await task; }
    finally { if (inFlightKey) inFlight?.delete(inFlightKey); }
  }

  private async perform<T>(opts: AiRunOptions<T>, cacheInput: CacheLookupInput | null): Promise<AiRunResult<T>> {
    const maxAttempts = this.config.maxRetries + 1;
    const body = JSON.stringify({
      model: opts.model, messages: opts.messages, max_tokens: Math.min(opts.maxTokens, this.config.maxOutputTokens),
      // 保留 DeepSeek 官方精确主机补丁，不推广到代理或其他服务。
      ...(new URL(this.config.baseUrl!).hostname === "api.deepseek.com" ? { thinking: { type: "disabled" } } : {}),
    });
    let repairs = 0;
    let lastError: AiError | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const slot = acquireAiSlot(this.config, opts.signal,
        { maxQueued: AI_QUEUE_LIMIT, waitMs: AI_QUEUE_WAIT_MS },
        { exhibitionId: opts.context.exhibitionId, workflowId: opts.context.workflowId ??
          (opts.context.scopeType === "workflow" ? opts.context.scopeId : null) });
      const release = typeof slot === "function" ? slot : await slot;
      let retryDelay: number | null = null;
      try {
        this.assertCurrent(opts);
        const hit = this.lookup(cacheInput, opts);
        if (hit) return hit;
        const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
        const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
        const call = reserveAiCall(this.db, {
          exhibitionId: opts.context.exhibitionId, scopeType: opts.context.scopeType, scopeId: opts.context.scopeId,
          agentType: opts.context.agentType, workflowId: opts.context.workflowId,
          provider: this.config.provider, model: opts.model, purpose: opts.context.purpose,
          promptVersion: opts.context.promptVersion, schemaVersion: opts.context.schemaVersion,
          preprocessVersion: opts.context.preprocessVersion, attempt,
        }, this.limits, this.nowFn());
        const startedAt = this.nowFn().getTime();
        let sent = false;
        let usage: AiUsage | null = null;
        let providerRequestId: string | null = null;
        let parsing = false;
        try {
          markAiCallSent(this.db, call.id);
          sent = true;
          const res = await this.transport(chatCompletionsUrl(this.config), {
            method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.config.apiKey}` },
            body, signal,
          });
          providerRequestId = extractRequestId(res, this.config.apiKey);
          const bodyText = await readBoundedBody(res, signal);
          signal.throwIfAborted();
          usage = extractUsage(bodyText);
          if (!res.ok) throw classifyProviderError(res, bodyText, this.config.apiKey ? [this.config.apiKey] : []);
          parsing = true;
          const data = opts.parse(extractContent(bodyText));
          this.assertCurrent(opts);
          this.settle(call.id, { status: "succeeded", durationMs: this.nowFn().getTime() - startedAt, usage, providerRequestId });
          if (cacheInput) cacheSave(this.db, { ...cacheInput, exhibitionId: opts.context.exhibitionId,
            result: data, sourceCallId: call.id, inputDigest: canonicalDigest(opts.messages) });
          return { data, callId: call.id, source: "fresh" };
        } catch (error) {
          if (!sent) { releaseAiReservation(this.db, call.id); throw error; }
          // 不存 provider body、Zod issue、异常原文或 signal.reason；它们都可能包含隐私。
          const name = error instanceof Error ? error.name : "";
          const classified = signal.aborted
            ? (timeout.aborted && signal.reason === timeout.reason ? new AiTimeoutError() : new AiCancelledError())
            : name === "TimeoutError" ? new AiTimeoutError()
            : name === "AbortError" ? new AiCancelledError()
            : isFormatError(error) ? new AiInvalidResponseError()
            : error instanceof AiError ? error
            : parsing ? new AiBusinessValidationError() : new AiNetworkError();
          this.settle(call.id, { status: "failed", durationMs: this.nowFn().getTime() - startedAt,
            usage, providerRequestId, errorClass: classified.cls, errorMessage: AI_ERROR_GUIDANCE[classified.cls] });
          lastError = classified;
          if (attempt < maxAttempts && classified instanceof AiInvalidResponseError && repairs === 0) {
            repairs++;
            retryDelay = 0;
          } else if (attempt < maxAttempts && classified.retryable) {
            retryDelay = backoffMs(attempt, classified.retryAfterMs);
          } else { throw classified; }
        }
      } finally { release(); }
      // 退避不持有 HTTP 名额，每次真实尝试重新排队。
      if (retryDelay !== null && retryDelay > 0) {
        try { await waitWithSignal(this.sleepMs(retryDelay), opts.signal); }
        catch (error) { assertNotCancelled(opts.signal); throw error; }
      }
    }
    throw lastError ?? new AiProviderError("模型调用失败。");
  }
}

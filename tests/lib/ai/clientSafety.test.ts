import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createDb } from "@/lib/db/client";
import { createExhibition } from "@/lib/db/repos";
import { CreateExhibitionInput } from "@/lib/agents/schemas";
import { AiClient, type AiRunOptions, type AiTransport } from "@/lib/ai/client";
import { loadAiConfig } from "@/lib/ai/config";
import { listAiCalls } from "@/lib/ai/records";
import { getBudgetUsage } from "@/lib/ai/budget";
import { AiBusinessValidationError } from "@/lib/ai/errors";
import { VisualFacts } from "@/lib/ai/schemas";
import { AI_QUEUE_WAIT_MS } from "@/lib/ai/limiter";

const config = (extra: Record<string, string> = {}) => loadAiConfig({
  NODE_ENV: "test", AI_API_KEY: "fakeKey-safety-only", AI_BASE_URL: "https://safety.invalid/v1",
  AI_VISION_MODEL: "vision", AI_MAX_RETRIES: "0", AI_MAX_CONCURRENCY: "1",
  AI_MAX_CALLS_PER_JOB: "100", ...extra,
});
const envelope = (content: unknown = '{"ok":true}', extra: object = {}) => new Response(JSON.stringify({
  choices: [{ message: { content }, finish_reason: "stop" }], ...extra,
}));
let db: DatabaseSync;
let exhibitionId: string;
let opts: AiRunOptions<{ ok: boolean }>;
beforeEach(() => {
  db = createDb(":memory:");
  exhibitionId = createExhibition(db, CreateExhibitionInput.parse({ allow_external_ai: true }), "ai").id;
  opts = { context: { purpose: "vision", scopeType: "workflow", scopeId: "wf-1", exhibitionId,
    promptVersion: "p1", schemaVersion: "s1", preprocessVersion: "i1" },
    model: "vision", messages: [{ role: "user", content: "synthetic image input" }], maxTokens: 100,
    parse: (text) => { const data = JSON.parse(text); if (data.ok !== true) throw new SyntaxError("bad data"); return data; },
  };
});
afterEach(() => { db.close(); vi.restoreAllMocks(); vi.useRealTimers(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("共享限流红灯回归", () => {
  it.each([1, 2])("跨实例/DB/transport/影展/探测/重试真实峰值=%i", async (limit) => {
    const otherDb = createDb(":memory:");
    const gate = deferred<void>();
    let active = 0, peak = 0, entered = 0;
    const calls = [0, 1, 2, 3, 4].map((i) => {
      let attempt = 0;
      const transport: AiTransport = async () => {
        entered++; active++; peak = Math.max(peak, active);
        await gate.promise;
        active--;
        return i === 0 && ++attempt === 1 ? new Response("busy", { status: 503 }) : envelope();
      };
      const context = i % 2 ? { ...opts.context, purpose: "connection_test" as const,
        scopeType: "connection_test" as const, scopeId: `probe-${i}`, exhibitionId: null } : opts.context;
      return new AiClient(i % 2 ? otherDb : db, config({ AI_MAX_CONCURRENCY: String(limit),
        AI_TEXT_MODEL: `text-${i}`, AI_MAX_RETRIES: String(i % 3 + 1) }), transport, async () => {})
        .run({ ...opts, context });
    });
    await vi.waitFor(() => expect(entered).toBeGreaterThanOrEqual(limit));
    gate.resolve();
    try {
      await Promise.all(calls);
      expect(peak).toBe(limit);
      expect(entered).toBe(6);
    } finally { otherDb.close(); }
  });

  it("排队取消零账本，释放后仍可请求", async () => {
    const gate = deferred<void>();
    const transport = vi.fn(async () => { await gate.promise; return envelope(); });
    const client = new AiClient(db, config(), transport);
    const first = client.run(opts);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const controller = new AbortController();
    const second = client.run({ ...opts, signal: controller.signal });
    const rejected = expect(second).rejects.toMatchObject({ cls: "cancelled" });
    controller.abort(new Error("private cancellation path"));
    gate.resolve();
    await first;
    await rejected;
    expect(listAiCalls(db)).toHaveLength(1);
    await client.run(opts);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each(["authorization", "active", "configuration", "budget"])("排队后重新检查 %s", async (kind) => {
    const gate = deferred<void>();
    const firstTransport = vi.fn(async () => { await gate.promise; return envelope(); });
    const first = new AiClient(db, config(), firstTransport).run(opts);
    await vi.waitFor(() => expect(firstTransport).toHaveBeenCalledTimes(1));
    const secondTransport = vi.fn(async () => envelope());
    let active = true;
    let current = config();
    const second = new AiClient(db, config(kind === "budget" ? { AI_MAX_CALLS_PER_JOB: "1" } : {}), secondTransport).run({
      ...opts,
      context: { ...opts.context, assertActive: () => { if (!active) throw new Error("stale run"); } },
      getCurrentConfig: kind === "configuration" ? () => current : undefined,
    });
    const rejected = expect(second).rejects.toThrow();
    if (kind === "authorization") db.prepare("UPDATE exhibitions SET allow_external_ai=0 WHERE id=?").run(exhibitionId);
    if (kind === "active") active = false;
    if (kind === "configuration") current = config({ AI_API_KEY: "fake-changed" });
    gate.resolve();
    await Promise.allSettled([first]);
    await rejected;
    expect(secondTransport).not.toHaveBeenCalled();
    expect(listAiCalls(db)).toHaveLength(1);
  });
});

describe("排队、取消和冻结输入边界", () => {
  it("获槽再次命中缓存（不同 transport 不合并），不新增账本", async () => {
    const gate = deferred<void>();
    const input = { ...opts, cacheKey: "recheck" };
    const firstTransport = vi.fn(async () => { await gate.promise; return envelope(); });
    const first = new AiClient(db, config(), firstTransport).run(input);
    const secondTransport = vi.fn(async () => envelope());
    const second = new AiClient(db, config(), secondTransport).run(input);
    gate.resolve();
    const results = await Promise.all([first, second]);
    expect(results[1]).toEqual({ ...results[0], source: "cache" });
    expect(secondTransport).not.toHaveBeenCalled();
    expect(listAiCalls(db)).toHaveLength(1);
  });

  it("排队期间原请求被修改，发送的仍是入队快照", async () => {
    const gate = deferred<void>();
    const first = new AiClient(db, config(), async () => { await gate.promise; return envelope(); }).run(opts);
    const transport = vi.fn<AiTransport>(async () => envelope());
    const original = structuredClone(opts.messages);
    const queued = new AiClient(db, config(), transport).run(opts);
    opts.messages[0].content = "changed-after-enqueue";
    gate.resolve();
    await Promise.all([first, queued]);
    expect(JSON.parse(String(transport.mock.calls[0]?.[1]?.body)).messages).toEqual(original);
  });

  it("排队等待超时不创建 ai_calls 或消耗预算", async () => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    const client = new AiClient(db, config(), async () => { await gate.promise; return envelope(); });
    const first = client.run(opts);
    const second = client.run(opts);
    const rejected = expect(second).rejects.toMatchObject({ cls: "queue" });
    await vi.advanceTimersByTimeAsync(AI_QUEUE_WAIT_MS);
    await rejected;
    gate.resolve();
    await first;
    expect(listAiCalls(db)).toHaveLength(1);
    expect(getBudgetUsage(db, { scopeType: "job" })).toBe(1);
    vi.useRealTimers();
  });

  it("合并等待者取消不取消源请求也不计账", async () => {
    const gate = deferred<void>();
    const transport = vi.fn(async () => { await gate.promise; return envelope(); });
    const client = new AiClient(db, config(), transport);
    const input = { ...opts, cacheKey: "coalesced" };
    const first = client.run(input);
    const controller = new AbortController();
    const waiter = client.run({ ...input, signal: controller.signal });
    const rejected = expect(waiter).rejects.toMatchObject({ cls: "cancelled" });
    controller.abort(new Error("secret reason"));
    await rejected;
    gate.resolve();
    expect((await first).source).toBe("fresh");
    expect(listAiCalls(db)).toHaveLength(1);
    expect((await client.run(input)).source).toBe("cache");
  });

  it("退避取消后不重发，HTTP 槽在退避时可用", async () => {
    const delay = deferred<void>();
    const controller = new AbortController();
    const sleeping = vi.fn(() => delay.promise);
    const transport = vi.fn(async () => new Response("busy", { status: 503 }));
    const running = new AiClient(db, config({ AI_MAX_RETRIES: "3" }), transport, sleeping)
      .run({ ...opts, signal: controller.signal });
    await vi.waitFor(() => expect(sleeping).toHaveBeenCalledOnce());
    const other = await new AiClient(db, config(), async () => envelope()).run(opts);
    expect(other.source).toBe("fresh");
    const rejected = expect(running).rejects.toMatchObject({ cls: "cancelled" });
    controller.abort();
    await rejected;
    delay.resolve();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(listAiCalls(db)).toHaveLength(2);
  });
});

describe("视觉持久缓存红灯回归", () => {
  it("同影展跨 workflow/新实例缓存，textModel 不影响视觉，原调用来源保持", async () => {
    const transport = vi.fn<AiTransport>(async () => envelope());
    const first = await new AiClient(db, config(), transport).run({ ...opts, cacheKey: "same" });
    const second = await new AiClient(db, config({ AI_TEXT_MODEL: "other" }), transport).run({
      ...opts, context: { ...opts.context, scopeId: "wf-2" }, cacheKey: "same",
    });
    expect(second).toEqual({ ...first, source: "cache" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(listAiCalls(db)).toHaveLength(1);
    expect(db.prepare("SELECT scope_type, scope_id FROM ai_cache").get()).toEqual({ scope_type: "job", scope_id: exhibitionId });
  });

  it.each(["base", "key", "model", "messages", "tokens", "prompt", "schema", "preprocess"])("实际 %s 改变不误命中", async (field) => {
    const transport = vi.fn<AiTransport>(async () => envelope());
    const input = { ...opts, cacheKey: "caller-key", inputDigest: "caller-digest" };
    await new AiClient(db, config(), transport).run(input);
    const other = { ...input, context: { ...input.context } };
    const overrides: Record<string, string> = {};
    if (field === "base") overrides.AI_BASE_URL = "https://other.invalid/v1";
    if (field === "key") overrides.AI_API_KEY = "fake-other";
    if (field === "model") other.model = "other";
    if (field === "messages") other.messages = [{ role: "user", content: "changed bytes" }];
    if (field === "tokens") other.maxTokens = 50;
    if (field === "prompt") other.context.promptVersion = "p2";
    if (field === "schema") other.context.schemaVersion = "s2";
    if (field === "preprocess") other.context.preprocessVersion = "i2";
    expect((await new AiClient(db, config(overrides), transport).run(other)).source).toBe("fresh");
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each(["not-json", '{"wrong":true}'])("坏缓存 %s 删除后补请求并替换", async (bad) => {
    const transport = vi.fn<AiTransport>(async () => envelope());
    const client = new AiClient(db, config(), transport);
    const input = { ...opts, cacheKey: "repair-cache" };
    await client.run(input);
    db.prepare("UPDATE ai_cache SET result_json=?").run(bad);
    const result = await client.run(input);
    expect(result.source).toBe("fresh");
    expect((await client.run(input)).source).toBe("cache");
    expect(transport).toHaveBeenCalledTimes(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM ai_cache").get()).toEqual({ n: 1 });
  });
});

describe("传输补充边界", () => {
  it.each(["fetch", "stream"])("真实 AbortSignal.timeout 在 %s 阶段正确结算并释放槽", async (phase) => {
    const cancel = vi.fn();
    const transport: AiTransport = phase === "fetch"
      ? async (_url, init) => new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      })
      : async () => new Response(new ReadableStream({ cancel }));
    const client = new AiClient(db, config({ AI_REQUEST_TIMEOUT_MS: "1000", AI_MAX_RETRIES: "3" }), transport);
    await expect(client.run(opts)).rejects.toMatchObject({ cls: "timeout" });
    expect(listAiCalls(db)).toMatchObject([{ status: "failed", error_class: "timeout", usage: null }]);
    if (phase === "stream") expect(cancel).toHaveBeenCalledOnce();
    expect((await new AiClient(db, config(), async () => envelope()).run(opts)).source).toBe("fresh");
  });

  it.each(["fetch", "stream"])("用户任意 signal 理由在 %s 阶段归为取消，不记原文", async (phase) => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const transport = vi.fn<AiTransport>(async (_url, init) => {
      if (phase === "stream") return new Response(new ReadableStream({ cancel }));
      return new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
    });
    const running = new AiClient(db, config(), transport).run({ ...opts, signal: controller.signal });
    const rejected = expect(running).rejects.toMatchObject({ cls: "cancelled" });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
    controller.abort(new Error("private-path-body-secret"));
    await rejected;
    expect(listAiCalls(db)[0]).toMatchObject({ status: "failed", error_class: "cancelled" });
    expect(JSON.stringify(listAiCalls(db))).not.toContain("body-secret");
    if (phase === "stream") expect(cancel).toHaveBeenCalledOnce();
  });

  it("业务引用错误不当格式重试，缓存不被引用失败污染", async () => {
    const transport = vi.fn(async () => envelope());
    const client = new AiClient(db, config({ AI_MAX_RETRIES: "3" }), transport);
    const input = { ...opts, cacheKey: "business" };
    const parse = () => { throw new AiBusinessValidationError(); };
    await expect(client.run({ ...input, parse })).rejects.toMatchObject({ cls: "invalid_reference" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(listAiCalls(db)[0]).toMatchObject({ status: "failed", error_class: "invalid_reference" });
    await client.run(input);
    await expect(client.run({ ...input, parse })).rejects.toMatchObject({ cls: "invalid_reference" });
    expect((await client.run(input)).source).toBe("cache");
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each([0, 1, 3])("schema 格式修复上限与 maxRetries=%i 共同生效", async (retries) => {
    const transport = vi.fn(async () => envelope());
    await expect(new AiClient(db, config({ AI_MAX_RETRIES: String(retries) }), transport).run({ ...opts,
      parse: (s) => VisualFacts.parse(JSON.parse(s)),
    })).rejects.toMatchObject({ cls: "invalid_response" });
    expect(transport).toHaveBeenCalledTimes(retries === 0 ? 1 : 2);
    expect(listAiCalls(db).every(c => c.status === "failed")).toBe(true);
  });

  it.each([false, true])("格式和 503 共用总尝试上限，第二个格式错误立即停止：%s", async (secondInvalid) => {
    const responses = [new Response("busy", { status: 503 }), envelope("bad-json"),
      secondInvalid ? envelope("bad-json") : new Response("busy", { status: 503 }), envelope()];
    const transport = vi.fn(async () => responses.shift()!);
    const running = new AiClient(db, config({ AI_MAX_RETRIES: "3" }), transport, async () => {}).run(opts);
    if (secondInvalid) await expect(running).rejects.toMatchObject({ cls: "invalid_response" });
    else expect((await running).source).toBe("fresh");
    expect(transport).toHaveBeenCalledTimes(secondInvalid ? 3 : 4);
    expect(listAiCalls(db).every(c => c.finished_at !== null)).toBe(true);
  });

  it.each([
    {}, { choices: {} }, { choices: [null] }, { choices: [{ message: { reasoning_content: "thinking only" } }] },
    { choices: [{ message: { content: '{"ok":true}' }, finish_reason: null }] },
    { choices: [{ message: { content: '{"ok":true}' }, finish_reason: {} }] },
  ])("拒绝损坏/只思考封套 %#", async (payload) => {
    const parse = vi.fn(opts.parse);
    await expect(new AiClient(db, config(), async () => new Response(JSON.stringify(payload))).run({ ...opts, parse }))
      .rejects.toMatchObject({ cls: "invalid_response" });
    expect(parse).not.toHaveBeenCalled();
  });

  it("无穷 usage 拒绝，路径或密钥 request id 不存储", async () => {
    const raw = '{"choices":[{"message":{"content":"{\\"ok\\":true}"}}],"usage":{"prompt_tokens":1e999}}';
    await new AiClient(db, config(), async () => new Response(raw, { headers: { "x-request-id": "/private/path fakeKey-safety-only" } })).run(opts);
    expect(listAiCalls(db)[0]).toMatchObject({ usage: null, provider_request_id: null });
  });

  it("响应流出错与超限错误分别分类，均结算且无原文", async () => {
    const body = new ReadableStream({ start(c) { c.error(new Error("secret-stream-path")); } });
    await expect(new AiClient(db, config(), async () => new Response(body)).run(opts)).rejects.toMatchObject({ cls: "network" });
    expect(listAiCalls(db)[0]).toMatchObject({ status: "failed", error_class: "network" });
    expect(JSON.stringify(listAiCalls(db))).not.toContain("secret-stream-path");
  });
});

describe("传输和结算红灯回归", () => {
  it.each([null, "", "  \n\t", [], { answer: "ok" }])("拒绝无效最终文本 %j", async (content) => {
    await expect(new AiClient(db, config(), async () => envelope(content)).run(opts)).rejects.toMatchObject({ cls: "invalid_response" });
    expect(listAiCalls(db)[0].status).toBe("failed");
  });
  it.each(["length", "content_filter"])("拒绝截断/过滤封套 %s 即使 JSON 可解析", async (finish_reason) => {
    const parse = vi.fn(opts.parse);
    await expect(new AiClient(db, config(), async () => envelope(undefined, {
      choices: [{ message: { content: '{"ok":true}' }, finish_reason }],
    })).run({ ...opts, parse })).rejects.toMatchObject({ cls: "invalid_response" });
    expect(parse).not.toHaveBeenCalled();
  });
  it("无 Content-Length 按字节中止，不等全流完成", async () => {
    let read = 0;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { read++; controller.enqueue(new TextEncoder().encode("汉".repeat(200_000))); if (read === 4) controller.close(); },
      cancel,
    });
    await expect(new AiClient(db, config(), async () => new Response(stream)).run(opts)).rejects.toMatchObject({ cls: "invalid_response" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(read).toBeLessThan(4);
  });
  it("usage 仅接受有限非负数", async () => {
    await new AiClient(db, config(), async () => envelope(undefined, {
      usage: { prompt_tokens: -1, completion_tokens: "3", total_tokens: 4 },
    })).run(opts);
    expect(listAiCalls(db)[0].usage).toEqual({ total_tokens: 4 });
  });
  it("格式修复至多一次，不消耗全部三次重试", async () => {
    const transport = vi.fn(async () => envelope("not-json"));
    await expect(new AiClient(db, config({ AI_MAX_RETRIES: "3" }), transport, async () => {}).run(opts))
      .rejects.toMatchObject({ cls: "invalid_response" });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(listAiCalls(db).every(c => c.status === "failed")).toBe(true);
  });
  it("TimeoutError 不当作 network，不盲目重发", async () => {
    const transport = vi.fn(async () => { throw new DOMException("secret path", "TimeoutError"); });
    await expect(new AiClient(db, config({ AI_MAX_RETRIES: "3" }), transport).run(opts)).rejects.toMatchObject({ cls: "timeout" });
    expect(listAiCalls(db)[0]).toMatchObject({ status: "failed", error_class: "timeout" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("解析器意外失败仍结算且不记录原始错误或路径", async () => {
    await expect(new AiClient(db, config(), async () => envelope()).run({ ...opts,
      parse: () => { throw new Error("/private/photos/name.jpg fakeKey-safety-only body-secret"); },
    })).rejects.toThrow();
    expect(listAiCalls(db)[0]).toMatchObject({ status: "failed" });
    expect(JSON.stringify(listAiCalls(db))).not.toMatch(/private|body-secret|fakeKey/);
    expect(getBudgetUsage(db, { scopeType: "job" })).toBe(1);
  });
});

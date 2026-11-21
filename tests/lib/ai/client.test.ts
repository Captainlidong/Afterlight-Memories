import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createDb } from "@/lib/db/client";
import { createExhibition } from "@/lib/db/repos";
import { CreateExhibitionInput } from "@/lib/agents/schemas";
import { loadAiConfig } from "@/lib/ai/config";
import { AiClient, type AiTransport, type AiRunOptions } from "@/lib/ai/client";
import { listAiCalls, getAiCall } from "@/lib/ai/records";
import { getBudgetUsage, releaseAiReservation } from "@/lib/ai/budget";
import { cacheClearScope, cacheGet, cacheSave } from "@/lib/ai/cache";
import { VisualFacts, type VisualFactsT } from "@/lib/ai/schemas";
import {
  AiConfigError,
  AiUnauthorizedError,
  AiProviderAuthError,
  AiTimeoutError,
  AiInvalidResponseError,
  AiBudgetError,
} from "@/lib/ai/errors";
import type { AiCallContext } from "@/lib/ai/policy";

const KEY = "sk-test-key-12345678";

let db: DatabaseSync;
let exh: string;

beforeAll(() => {
  db = createDb(":memory:");
  exh = createExhibition(
    db,
    CreateExhibitionInput.parse({ title: "AI 影展", allow_external_ai: true }),
    "ai",
  ).id;
});

afterAll(() => {
  db.close();
});

function makeConfig(overrides: Record<string, string | number | boolean> = {}): ReturnType<typeof loadAiConfig> {
  const merged = {
    AI_API_KEY: KEY,
    AI_BASE_URL: "https://api.example.com/v1",
    AI_VISION_MODEL: "vision-x",
    AI_MAX_RETRIES: 1,
    AI_REQUEST_TIMEOUT_MS: 60_000,
    ...overrides,
  };
  return loadAiConfig(Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, String(v)])) as NodeJS.ProcessEnv);
}

function makeClient(config = makeConfig(), transport?: AiTransport): AiClient {
  return new AiClient(db, config, transport, async () => {}, () => new Date("2026-11-20T03:00:00.000Z"));
}

function ctx(overrides: Partial<AiCallContext> = {}): AiCallContext {
  return {
    purpose: "vision",
    scopeType: "workflow",
    scopeId: "wf-1",
    exhibitionId: exh,
    promptVersion: "vision-v1",
    schemaVersion: "visual-facts-v1",
    preprocessVersion: "prep-v1",
    ...overrides,
  };
}

const FACTS = {
  summary: "一扇窗边有一个人。",
  subjects: ["窗", "人物"],
  composition_tags: ["框景"],
  light_tags: ["侧光"],
  spatial_relations: ["人物靠近窗边"],
  evidence: [{ kind: "observation", text: "人物没有正面朝向镜头" }],
  uncertainties: [],
};

const visionParse = (content: string) => VisualFacts.parse(JSON.parse(content));

function okResponse(payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(payload) } }],
      usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 },
    }),
    { status: 200, headers: { "x-request-id": "req-1", ...headers } },
  );
}

function errResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

describe("统一客户端：成功路径与调用记录（V05/V17/V21 模块侧）", () => {
  it("真实外发成功：结构校验、usage 与 request_id 记账、来源 fresh", async () => {
    const transport = vi.fn(async () => okResponse(FACTS));
    const client = makeClient(makeConfig(), transport);
    const result = await client.run({
      context: ctx(),
      model: "vision-x",
      messages: [{ role: "system", content: "观察" }, { role: "user", content: "看图" }],
      maxTokens: 2500,
      parse: visionParse,
    });
    expect(result.source).toBe("fresh");
    expect(result.data.summary).toBe(FACTS.summary);
    expect(transport).toHaveBeenCalledTimes(1);

    const calls = listAiCalls(db, { scopeId: "wf-1" });
    expect(calls.length).toBe(1);
    expect(result.callId).toBe(calls[0].id);
    expect(calls[0].status).toBe("succeeded");
    expect(calls[0].usage?.total_tokens).toBe(14);
    expect(calls[0].provider_request_id).toBe("req-1");
    expect(calls[0].attempt).toBe(1);
  });

  it("请求体只含 model/messages/max_tokens，Key 只进 Authorization 头", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | null = null;
    const transport = vi.fn(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return okResponse(FACTS);
    });
    const client = makeClient(makeConfig(), transport);
    await client.run({ context: ctx(), model: "vision-x", messages: [], maxTokens: 2500, parse: visionParse });
    expect(capturedUrl).toBe("https://api.example.com/v1/chat/completions");
    const body = JSON.parse(String(capturedInit!.body));
    expect(body.max_tokens).toBe(2500);
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model"]);
    const auth = (capturedInit!.headers as Record<string, string>).authorization;
    expect(auth).toBe(`Bearer ${KEY}`);
  });

  it("usage 缺失记 null（未知 ≠ 0）", async () => {
    const transport = vi.fn(
      async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(FACTS) } }] }), { status: 200 }),
    );
    const client = makeClient(makeConfig(), transport);
    await client.run({ context: ctx({ scopeId: "wf-nousage" }), model: "vision-x", messages: [], maxTokens: 2500, parse: visionParse });
    expect(listAiCalls(db, { scopeId: "wf-nousage" })[0].usage).toBeNull();
  });
});

describe("DeepSeek 官方请求 / Mock", () => {
  let localDb: DatabaseSync;
  let exhibitionId: string;
  beforeEach(() => {
    localDb = createDb(":memory:");
    exhibitionId = createExhibition(
      localDb, CreateExhibitionInput.parse({ allow_external_ai: true }), "ai",
    ).id;
  });
  afterEach(() => { localDb.close(); });

  it.each([
    ["https://api.deepseek.com", true],
    ["https://api.deepseek.com/v1/", true],
    ["https://API.DEEPSEEK.COM/v1", true],
    ["https://api.deepseek.com.example.invalid/v1", false],
    ["https://proxy.invalid/api.deepseek.com/v1", false],
    ["https://deepseek-proxy.invalid/v1", false],
  ])("只对官方主机关闭思考模式：%s", async (baseUrl, official) => {
    const config = makeConfig({ AI_BASE_URL: baseUrl, AI_VISION_MODEL: "deepseek-flash", AI_MAX_RETRIES: 0 });
    const transport = vi.fn<AiTransport>(async () => okResponse(FACTS));
    const client = new AiClient(localDb, config, transport);
    const messages = [{ role: "user" as const, content: "只返回照片事实 JSON" }];
    await client.run({ context: ctx({ exhibitionId }), model: "deepseek-flash", messages, maxTokens: 100, parse: visionParse });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe(`${String(baseUrl).replace(/\/+$/, "")}/chat/completions`);
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      model: "deepseek-flash", messages, max_tokens: 100,
      ...(official ? { thinking: { type: "disabled" } } : {}),
    });
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(getBudgetUsage(localDb, { scopeType: "job" })).toBe(1);
  });
});

const legacyWorkflowContext = ctx;
describe("非视觉缓存与并发合并（V14/V15/V18，保留 workflow 隔离）", () => {
  // 这些旧作用域/引用复验断言继续约束非视觉请求；视觉跨 workflow 见 clientSafety。
  const ctx = (overrides: Partial<AiCallContext> = {}) => legacyWorkflowContext({ purpose: "curation", ...overrides });
  it("相同键第二次不外发（source=cache），不新增调用记录", async () => {
    const transport = vi.fn(async () => okResponse(FACTS));
    const client = makeClient(makeConfig(), transport);
    const opts: AiRunOptions<VisualFactsT> = {
      context: ctx({ scopeId: "wf-cache" }),
      model: "vision-x",
      messages: [{ role: "user", content: "同一张图" }],
      maxTokens: 2500,
      parse: vi.fn(visionParse),
      cacheKey: "key-1",
      inputDigest: "d1",
    };
    const r1 = await client.run(opts);
    const budgetBeforeHit = getBudgetUsage(db);
    const r2 = await makeClient(makeConfig(), transport).run(opts);
    expect(r1.source).toBe("fresh");
    expect(r2.source).toBe("cache");
    expect(r2.data).toEqual(FACTS);
    expect(r1.callId).toBe(listAiCalls(db, { scopeId: "wf-cache" })[0].id);
    expect(r2.callId).toBe(r1.callId);
    expect(opts.parse).toHaveBeenCalledTimes(2);
    expect(getBudgetUsage(db)).toBe(budgetBeforeHit);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(listAiCalls(db, { scopeId: "wf-cache" }).length).toBe(1);
  });

  it("并发相同键合并请求：只外发一次，双方拿到同一结果", async () => {
    let resolveFn!: (r: Response) => void;
    const transport = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFn = resolve;
        }),
    );
    const client = makeClient(makeConfig(), transport);
    const opts: AiRunOptions<VisualFactsT> = {
      context: ctx({ scopeId: "wf-merge" }),
      model: "vision-x",
      messages: [{ role: "user", content: "同一张图" }],
      maxTokens: 2500,
      parse: visionParse,
      cacheKey: "key-merge",
      inputDigest: "d1",
    };
    const reparse = vi.fn((content: string) => ({ ...visionParse(content), summary: "重新校验的结果" }));
    const p1 = client.run(opts);
    const p2 = client.run({ ...opts, parse: reparse });
    resolveFn(okResponse(FACTS));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(r1.data).toEqual(FACTS);
    expect(r2.data).toEqual({ ...FACTS, summary: "重新校验的结果" });
    expect(reparse).toHaveBeenCalledWith(JSON.stringify(FACTS));
    expect(r1.callId).toBe(listAiCalls(db, { scopeId: "wf-merge" })[0].id);
    expect(r2.callId).toBe(r1.callId);
    expect([r1.source, r2.source].sort()).toEqual(["cache", "fresh"]);
  });

  it.each([
    "scopeType", "scopeId", "exhibitionId", "purpose", "model",
    "promptVersion", "schemaVersion", "preprocessVersion", "cacheKey",
  ] as const)("并发相同输入在 %s 不同时不合并", async (field) => {
    const transport = vi.fn(async () => okResponse(FACTS));
    const client = makeClient(makeConfig(), transport);
    const opts: AiRunOptions<VisualFactsT> = {
      context: ctx({ scopeId: `wf-isolation-${field}` }),
      model: "vision-x",
      messages: [{ role: "user", content: "相同输入" }],
      maxTokens: 2500,
      parse: visionParse,
      cacheKey: "same-input",
    };
    const other = { ...opts, context: { ...opts.context } };
    switch (field) {
      case "scopeType": other.context.scopeType = "job"; break;
      case "scopeId": other.context.scopeId += "-other"; break;
      case "exhibitionId":
        other.context.exhibitionId = createExhibition(
          db, CreateExhibitionInput.parse({ title: "隔离影展", allow_external_ai: true }), "ai",
        ).id;
        break;
      case "purpose": other.context.purpose = "narrative"; break;
      case "model": other.model = "vision-y"; break;
      case "cacheKey": other.cacheKey = "other-input"; break;
      default: other.context[field] = "v2";
    }
    const [first, second] = await Promise.all([
      client.run(opts), makeClient(makeConfig(), transport).run(other),
    ]);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(first.source).toBe("fresh");
    expect(second.source).toBe("fresh");
    expect(first.callId).not.toBe(second.callId);
    expect(getAiCall(db, second.callId!)?.model).toBe(other.model);
  });

  it.each(["cache", "coalesced"] as const)("%s 必须重新通过调用方业务校验，失败不补发请求", async (source) => {
    const transport = vi.fn(async () => okResponse(FACTS));
    const client = makeClient(makeConfig(), transport);
    const opts: AiRunOptions<VisualFactsT> = {
      context: ctx({ scopeId: `wf-validation-${source}` }),
      model: "vision-x", messages: [], maxTokens: 2500, parse: visionParse,
      cacheKey: "validation",
    };
    const first = client.run(opts);
    if (source === "cache") await first;
    const budgetBeforeReuse = getBudgetUsage(db);
    const parse = vi.fn((content: string) => {
      const data = visionParse(content);
      if (data.subjects.includes("人物")) throw new AiInvalidResponseError("业务校验拒绝人物");
      return data;
    });
    await expect(makeClient(makeConfig(), transport).run({ ...opts, parse })).rejects.toThrowError(AiInvalidResponseError);
    await first;
    expect(parse).toHaveBeenCalledWith(JSON.stringify(FACTS));
    expect(transport).toHaveBeenCalledTimes(1);
    expect(listAiCalls(db, { scopeId: opts.context.scopeId })).toHaveLength(1);
    expect(getBudgetUsage(db)).toBe(budgetBeforeReuse);
  });

  it("无效缓存结构直接拒绝，不外发、不新增记录或预算", async () => {
    const scopeId = "wf-invalid-cache";
    cacheSave(db, {
      ...ctx({ scopeId }), preprocessVersion: "prep-v1",
      cacheKey: "invalid-cache", provider: "openai-compatible", model: "vision-x",
      result: { not: "facts" }, sourceCallId: "original-call", inputDigest: "d",
    });
    const transport = vi.fn(async () => okResponse(FACTS));
    const parse = vi.fn(visionParse);
    const budgetBeforeHit = getBudgetUsage(db);
    await expect(makeClient(makeConfig(), transport).run({
      context: ctx({ scopeId }), model: "vision-x", messages: [], maxTokens: 2500,
      parse, cacheKey: "invalid-cache",
    })).rejects.toThrowError(AiInvalidResponseError);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(transport).not.toHaveBeenCalled();
    expect(listAiCalls(db, { scopeId })).toHaveLength(0);
    expect(getBudgetUsage(db)).toBe(budgetBeforeHit);
  });

  it("旧缓存的来源调用 ID 为 null 时保留 null", async () => {
    const scopeId = "wf-null-cache-id";
    cacheSave(db, {
      ...ctx({ scopeId }), preprocessVersion: "prep-v1",
      cacheKey: "null-call", provider: "openai-compatible", model: "vision-x",
      result: FACTS, sourceCallId: null, inputDigest: "d",
    });
    const transport = vi.fn(async () => okResponse(FACTS));
    const result = await makeClient(makeConfig(), transport).run({
      context: ctx({ scopeId }), model: "vision-x", messages: [], maxTokens: 2500,
      parse: visionParse, cacheKey: "null-call",
    });
    expect(result).toEqual({ data: FACTS, source: "cache", callId: null });
    expect(transport).not.toHaveBeenCalled();
    expect(listAiCalls(db, { scopeId })).toHaveLength(0);
  });

  it("缓存命中仍检查最新授权，撤销后不返回缓存或补发请求", async () => {
    const exhibitionId = createExhibition(
      db, CreateExhibitionInput.parse({ title: "撤销缓存授权", allow_external_ai: true }), "ai",
    ).id;
    const transport = vi.fn(async () => okResponse(FACTS));
    const client = makeClient(makeConfig(), transport);
    const parse = vi.fn(visionParse);
    const opts: AiRunOptions<VisualFactsT> = {
      context: ctx({ scopeId: "wf-cache-revoked", exhibitionId }),
      model: "vision-x", messages: [], maxTokens: 2500, parse, cacheKey: "revoked",
    };
    await client.run(opts);
    const budgetBeforeHit = getBudgetUsage(db);
    db.prepare("UPDATE exhibitions SET allow_external_ai=0 WHERE id=?").run(exhibitionId);
    await expect(client.run(opts)).rejects.toThrowError(AiUnauthorizedError);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(listAiCalls(db, { exhibitionId })).toHaveLength(1);
    expect(getBudgetUsage(db)).toBe(budgetBeforeHit);
  });

  it("并发等待期间撤销授权，合并调用在返回数据前拒绝", async () => {
    const exhibitionId = createExhibition(
      db, CreateExhibitionInput.parse({ title: "撤销等待授权", allow_external_ai: true }), "ai",
    ).id;
    const transport = vi.fn(async () => okResponse(FACTS));
    const client = makeClient(makeConfig(), transport);
    const opts: AiRunOptions<VisualFactsT> = {
      context: ctx({ scopeId: "wf-coalesced-revoked", exhibitionId }),
      model: "vision-x", messages: [], maxTokens: 2500, parse: visionParse, cacheKey: "revoked",
    };
    const first = client.run(opts);
    const parses = [vi.fn(visionParse), vi.fn(visionParse)];
    const waiters = parses.map((parse) => makeClient(makeConfig(), transport).run({ ...opts, parse }));
    const budgetBeforeRevoke = getBudgetUsage(db);
    db.prepare("UPDATE exhibitions SET allow_external_ai=0 WHERE id=?").run(exhibitionId);
    await Promise.all([first, ...waiters].map((waiter) => expect(waiter).rejects.toThrowError(AiUnauthorizedError)));
    for (const parse of parses) expect(parse).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(listAiCalls(db, { exhibitionId })).toHaveLength(1);
    expect(getBudgetUsage(db)).toBe(budgetBeforeRevoke);
  });

  describe("跨 AiClient 的请求合并边界", () => {
    let sharedDb: DatabaseSync;
    let exhibitionId: string;

    beforeEach(() => {
      // 每例独立数据库和影展，不共享持久任务预算。
      sharedDb = createDb(":memory:");
      exhibitionId = createExhibition(
        sharedDb, CreateExhibitionInput.parse({ title: "跨实例合并", allow_external_ai: true }), "ai",
      ).id;
    });

    afterEach(() => { sharedDb.close(); });

    function sharedClient(transport: AiTransport, config = makeConfig()): AiClient {
      return new AiClient(sharedDb, config, transport, async () => {}, () => new Date("2026-11-20T03:00:00.000Z"));
    }

    function options(scopeId: string): AiRunOptions<VisualFactsT> {
      return {
        context: ctx({ scopeId, exhibitionId }), model: "vision-x",
        messages: [{ role: "user", content: "同一张图" }], maxTokens: 2500,
        parse: visionParse, cacheKey: "same-key", inputDigest: "same-caller-digest",
      };
    }

    it("同 DB、transport、等值配置的两个实例只外发一次；完成后清理合并项", async () => {
      const transport = vi.fn(async () => okResponse(FACTS));
      const firstClient = sharedClient(transport);
      const secondClient = sharedClient(transport, { ...makeConfig() });
      const opts = options("cross-client-same");
      const budgetBefore = getBudgetUsage(sharedDb, { scopeType: "global" });
      const [first, second] = await Promise.all([firstClient.run(opts), secondClient.run(opts)]);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(first).toEqual({ data: FACTS, source: "fresh", callId: expect.any(String) });
      expect(second).toEqual({ ...first, source: "cache" });
      expect(listAiCalls(sharedDb, { scopeId: opts.context.scopeId })).toHaveLength(1);
      expect(getBudgetUsage(sharedDb, { scopeType: "global" })).toBe(budgetBefore + 1);

      // 删除持久缓存后必须重新外发，不能复用已完成的内存 Promise。
      expect(cacheClearScope(sharedDb, opts.context.scopeType, opts.context.scopeId)).toBe(1);
      const [next, waiting] = await Promise.all([secondClient.run(opts), firstClient.run(opts)]);
      expect(transport).toHaveBeenCalledTimes(2);
      expect(next.source).toBe("fresh");
      expect(next.callId).not.toBe(first.callId);
      expect(waiting.callId).toBe(next.callId);
      expect(waiting.source).toBe("cache");
    });

    it("相同请求和影展 ID 在不同 DatabaseSync 对象上不合并", async () => {
      const otherDb = createDb(":memory:");
      try {
        const otherId = createExhibition(
          otherDb, CreateExhibitionInput.parse({ allow_external_ai: true }), "ai",
        ).id;
        // 让两个数据库中的所有请求字段完全相同，仅 DB 对象身份不同。
        otherDb.prepare("UPDATE exhibitions SET id=? WHERE id=?").run(exhibitionId, otherId);
        const transport = vi.fn(async () => okResponse(FACTS));
        const otherClient = new AiClient(otherDb, makeConfig(), transport, async () => {});
        const opts = options("cross-client-db");
        const [first, second] = await Promise.all([sharedClient(transport).run(opts), otherClient.run(opts)]);
        expect(transport).toHaveBeenCalledTimes(2);
        expect([first.source, second.source]).toEqual(["fresh", "fresh"]);
        expect(first.callId).not.toBe(second.callId);
        expect(listAiCalls(sharedDb, { scopeId: opts.context.scopeId })).toHaveLength(1);
        expect(listAiCalls(otherDb)).toHaveLength(1);
      } finally { otherDb.close(); }
    });

    it("不同 transport 函数的实例不合并，Mock 结果不串用", async () => {
      const firstTransport = vi.fn(async () => okResponse(FACTS));
      const otherFacts = { ...FACTS, summary: "另一个 Mock 的结果" };
      const secondTransport = vi.fn(async () => okResponse(otherFacts));
      const opts = options("cross-client-transport");
      const [first, second] = await Promise.all([
        sharedClient(firstTransport).run(opts), sharedClient(secondTransport).run(opts),
      ]);
      expect(firstTransport).toHaveBeenCalledTimes(1);
      expect(secondTransport).toHaveBeenCalledTimes(1);
      expect(first.data).toEqual(FACTS);
      expect(second.data).toEqual(otherFacts);
      expect([first.source, second.source]).toEqual(["fresh", "fresh"]);
      expect(first.callId).not.toBe(second.callId);
    });

    it.each([
      ["AI_BASE_URL", "https://other.example.com/v1"],
      ["AI_API_KEY", "sk-other-test-key-87654321"],
      ["AI_MAX_CALLS_PER_JOB", 41],
      ["AI_MAX_CALLS_PER_DAY", 101],
      ["AI_CONNECTION_TEST_LIMIT_PER_HOUR", 6],
      ["AI_DAY_TIMEZONE", "UTC"],
      ["AI_MAX_RETRIES", 0],
      ["AI_REQUEST_TIMEOUT_MS", 30_000],
      ["AI_MAX_OUTPUT_TOKENS", 3000],
      ["AI_MAX_CONCURRENCY", 3],
      ["AI_VISION_MODEL", "configured-vision-y"],
    ] as const)("配置 %s 不同的实例不合并", async (field, value) => {
      const transport = vi.fn(async () => okResponse(FACTS));
      const opts = options(`cross-client-config-${field}`);
      const [first, second] = await Promise.all([
        sharedClient(transport).run(opts), sharedClient(transport, makeConfig({ [field]: value })).run(opts),
      ]);
      expect(transport).toHaveBeenCalledTimes(2);
      expect([first.source, second.source]).toEqual(["fresh", "fresh"]);
      expect(first.callId).not.toBe(second.callId);
    });

    it.each([
      ["same-instance", "messages"], ["cross-instance", "messages"],
      ["same-instance", "maxTokens"], ["cross-instance", "maxTokens"],
    ] as const)("%s：实际 %s 不同，即使 cacheKey/inputDigest 相同也不合并", async (mode, field) => {
      const transport = vi.fn(async () => okResponse(FACTS));
      const client = sharedClient(transport);
      const otherClient = mode === "same-instance" ? client : sharedClient(transport);
      const opts = options(`request-${mode}-${field}`);
      const other = { ...opts };
      if (field === "messages") other.messages = [{ role: "user", content: "不同的图" }];
      else other.maxTokens = 1000;
      const [first, second] = await Promise.all([client.run(opts), otherClient.run(other)]);
      expect(transport).toHaveBeenCalledTimes(2);
      expect([first.source, second.source]).toEqual(["fresh", "fresh"]);
      expect(first.callId).not.toBe(second.callId);
    });

    it("maxTokens 封顶后实际请求相同的实例可以合并", async () => {
      const transport = vi.fn(async () => okResponse(FACTS));
      const opts = options("cross-client-clamped-tokens");
      const [first, second] = await Promise.all([
        sharedClient(transport).run({ ...opts, maxTokens: 3000 }),
        sharedClient(transport).run({ ...opts, maxTokens: 5000 }),
      ]);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(second.callId).toBe(first.callId);
      expect(second.source).toBe("cache");
    });

    it.each(["cache-disabled", "connection-test", "no-cache-key"] as const)("%s 跨实例不合并且不读写持久缓存", async (mode) => {
      const transport = vi.fn(async () => okResponse(FACTS));
      const opts = options(`cross-client-${mode}`);
      const config = makeConfig({ AI_CACHE_ENABLED: mode !== "cache-disabled" });
      if (mode === "connection-test") {
        opts.context = { ...opts.context, purpose: "connection_test", scopeType: "connection_test", exhibitionId: null };
      }
      if (mode === "no-cache-key") delete opts.cacheKey;
      const firstClient = sharedClient(transport, config);
      const secondClient = sharedClient(transport, { ...config });
      const firstTwo = await Promise.all([firstClient.run(opts), secondClient.run(opts)]);
      const third = await sharedClient(transport, config).run(opts);
      expect(transport).toHaveBeenCalledTimes(3);
      expect([...firstTwo, third].map((r) => r.source)).toEqual(["fresh", "fresh", "fresh"]);
      expect(listAiCalls(sharedDb, { scopeId: opts.context.scopeId })).toHaveLength(3);
      expect(sharedDb.prepare("SELECT COUNT(*) AS n FROM ai_cache WHERE scope_type=? AND scope_id=?")
        .get(opts.context.scopeType, opts.context.scopeId)).toEqual({ n: 0 });
    });

    it("关闭缓存的实例不会加入开启缓存实例的请求", async () => {
      const transport = vi.fn(async () => okResponse(FACTS));
      const opts = options("cross-client-mixed-cache");
      const [first, second] = await Promise.all([
        sharedClient(transport).run(opts),
        sharedClient(transport, makeConfig({ AI_CACHE_ENABLED: false })).run(opts),
      ]);
      expect(transport).toHaveBeenCalledTimes(2);
      expect([first.source, second.source]).toEqual(["fresh", "fresh"]);
    });

    it.each(["schema", "business"] as const)("一个等待者 %s parse 失败不污染其他等待者或持久缓存", async (kind) => {
      const transport = vi.fn(async () => okResponse(FACTS));
      const opts = options(`cross-client-parse-${kind}`);
      const rejectingParse = vi.fn((content: string) => {
        if (kind === "schema") return VisualFacts.parse({});
        visionParse(content);
        throw new AiInvalidResponseError("当前调用方业务校验失败");
      });
      const otherParse = vi.fn((content: string) => ({ ...visionParse(content), summary: "另一个调用方的解析" }));
      const first = sharedClient(transport).run(opts);
      const rejected = sharedClient(transport).run({ ...opts, parse: rejectingParse });
      const other = sharedClient(transport).run({ ...opts, parse: otherParse });
      const [fresh, , waiting] = await Promise.all([
        first, expect(rejected).rejects.toThrowError(AiInvalidResponseError), other,
      ]);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(rejectingParse).toHaveBeenCalledOnce();
      expect(otherParse).toHaveBeenCalledWith(JSON.stringify(FACTS));
      expect(waiting).toEqual({ data: { ...FACTS, summary: "另一个调用方的解析" }, source: "cache", callId: fresh.callId });
      expect(getAiCall(sharedDb, fresh.callId!)?.status).toBe("succeeded");
      expect((await sharedClient(transport).run(opts)).data).toEqual(FACTS);
      expect(transport).toHaveBeenCalledTimes(1);
    });

    it.each(["network", "auth", "invalid_response", "transient"] as const)("共享请求 %s 拒绝后清理，下一轮能重新请求并合并", async (errorClass) => {
      let failing = true;
      const transport = vi.fn(async () => {
        if (!failing) return okResponse(FACTS);
        if (errorClass === "network") throw new Error("mock network failure");
        if (errorClass === "auth") return errResponse(401, "mock unauthorized");
        if (errorClass === "invalid_response") return okResponse({ not: "facts" });
        return errResponse(503, "mock unavailable");
      });
      const client = sharedClient(transport);
      const opts = options(`cross-client-failure-${errorClass}`);
      const results = await Promise.allSettled([client.run(opts), sharedClient(transport).run(opts)]);
      for (const result of results) {
        expect(result).toMatchObject({ status: "rejected", reason: { cls: errorClass } });
      }
      const attempts = errorClass === "invalid_response" || errorClass === "transient" ? 2 : 1;
      expect(transport).toHaveBeenCalledTimes(attempts);
      expect(listAiCalls(sharedDb, { scopeId: opts.context.scopeId })).toHaveLength(attempts);
      failing = false;
      const [recovered, waiting] = await Promise.all([client.run(opts), sharedClient(transport).run(opts)]);
      expect(transport).toHaveBeenCalledTimes(attempts + 1);
      expect(recovered.source).toBe("fresh");
      expect(recovered.data).toEqual(FACTS);
      expect(waiting).toEqual({ ...recovered, source: "cache" });
      expect(listAiCalls(sharedDb, { scopeId: opts.context.scopeId })).toHaveLength(attempts + 1);
    });

    it("预算预留被回收后拒绝发送，不能把 released 改回 sent", async () => {
      const transport = vi.fn(async () => okResponse(FACTS));
      let reads = 0;
      const client = new AiClient(sharedDb, makeConfig(), transport, async () => {}, () => {
        if (++reads === 2) {
          expect(releaseAiReservation(sharedDb, listAiCalls(sharedDb)[0].id)).toBe(true);
        }
        return new Date("2026-11-20T03:00:00Z");
      });
      await expect(client.run(options("released-before-send"))).rejects.toThrow(AiBudgetError);
      expect(transport).not.toHaveBeenCalled();
      expect(listAiCalls(sharedDb)).toMatchObject([{ status: "released" }]);
      expect(getBudgetUsage(sharedDb, { scopeType: "global" })).toBe(0);
      expect(getBudgetUsage(sharedDb, { scopeType: "job" })).toBe(0);
    });

    it("跨实例仍不扩大持久缓存到其他 scope", async () => {
      const transport = vi.fn(async () => okResponse(FACTS));
      const opts = options("cross-client-persistent-scope");
      const first = await sharedClient(transport).run(opts);
      const second = await sharedClient(transport).run({
        ...opts, context: { ...opts.context, scopeId: `${opts.context.scopeId}-other` },
      });
      expect(transport).toHaveBeenCalledTimes(2);
      expect(second.source).toBe("fresh");
      expect(second.callId).not.toBe(first.callId);
    });
  });

  it("轮询/只读场景本身不经过客户端 → 不产生任何调用记录", () => {
    // 客户端是唯一外发入口：未调用 run 就不存在 ai_calls（导出/放映路径不 import 客户端）。
    expect(listAiCalls(db, { scopeId: "wf-never" }).length).toBe(0);
  });
});

describe("重试与格式修复（V13/V16/V19）", () => {
  it("429 限流重试一次后成功：每次尝试独立记账、独立占预算", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(errResponse(429, "rate limited", { "retry-after": "0" }))
      .mockResolvedValueOnce(okResponse(FACTS));
    const client = makeClient(makeConfig(), transport);
    const r = await client.run({
      context: ctx({ scopeId: "wf-429" }),
      model: "vision-x",
      messages: [],
      maxTokens: 2500,
      parse: visionParse,
    });
    expect(r.source).toBe("fresh");
    expect(transport).toHaveBeenCalledTimes(2);
    const calls = listAiCalls(db, { scopeId: "wf-429" });
    expect(calls).toHaveLength(2);
    expect(calls.find((c) => c.attempt === 1)?.error_class).toBe("transient");
    expect(calls.find((c) => c.attempt === 2)?.status).toBe("succeeded");
    expect(r.callId).toBe(calls.find((c) => c.attempt === 2)?.id);
    expect(r.callId).not.toBe(calls.find((c) => c.attempt === 1)?.id);
  });

  it.each(["backoff", "format-repair"] as const)("%s 期间撤销授权后不预留预算、不再次外发", async (phase) => {
    const exhibitionId = createExhibition(
      db, CreateExhibitionInput.parse({ title: "撤销重试授权", allow_external_ai: true }), "ai",
    ).id;
    const revoke = () => {
      db.prepare("UPDATE exhibitions SET allow_external_ai=0 WHERE id=?").run(exhibitionId);
    };
    const transport = vi.fn(async () => phase === "backoff"
      ? errResponse(429, "rate limited", { "retry-after": "0" })
      : okResponse({ not: "facts" }));
    const client = new AiClient(db, makeConfig(), transport, async () => { revoke(); });
    const budgetBeforeRun = getBudgetUsage(db, { scopeType: "global" });
    await expect(client.run({
      context: ctx({ scopeId: `wf-retry-revoked-${phase}`, exhibitionId }),
      model: "vision-x", messages: [], maxTokens: 2500,
      parse: (content) => {
        if (phase === "format-repair") revoke();
        return visionParse(content);
      },
    })).rejects.toThrowError(AiUnauthorizedError);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(listAiCalls(db, { exhibitionId })).toHaveLength(1);
    expect(getBudgetUsage(db, { scopeType: "global" })).toBe(budgetBeforeRun + 1);
  });

  it("结构无效：不落库不缓存，格式修复受总次数上限，最终抛 invalid_response", async () => {
    const transport = vi.fn(async () => okResponse({ not: "facts" }));
    const client = makeClient(makeConfig(), transport);
    await expect(
      client.run({
        context: ctx({ scopeId: "wf-badjson" }),
        model: "vision-x",
        messages: [],
        maxTokens: 2500,
        parse: visionParse,
        cacheKey: "bad-1",
        inputDigest: "d",
      }),
    ).rejects.toThrowError(AiInvalidResponseError);
    // maxRetries=1 → 初次 + 1 次格式修复 = 2 次外发
    expect(transport).toHaveBeenCalledTimes(2);
    const calls = listAiCalls(db, { scopeId: "wf-badjson" });
    expect(calls.every((c) => c.status === "failed" && c.error_class === "invalid_response")).toBe(true);
    expect(
      cacheGet(db, {
        scopeType: "workflow",
        scopeId: "wf-badjson",
        purpose: "vision",
        cacheKey: "bad-1",
        provider: "openai-compatible",
        model: "vision-x",
        promptVersion: "vision-v1",
        schemaVersion: "visual-facts-v1",
        preprocessVersion: "prep-v1",
      }),
    ).toBeNull();
  });

  it("响应超过大小上限：按 invalid_response 拒绝，不落库不缓存", async () => {
    const huge = "x".repeat(1_100_000);
    const transport = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: huge } }] }), { status: 200 }),
    );
    const client = makeClient(makeConfig({ AI_MAX_RETRIES: 0 }), transport);
    await expect(
      client.run({
        context: ctx({ scopeId: "wf-huge" }),
        model: "vision-x",
        messages: [],
        maxTokens: 2500,
        parse: visionParse,
        cacheKey: "huge-1",
        inputDigest: "d",
      }),
    ).rejects.toThrowError(AiInvalidResponseError);
    const call = listAiCalls(db, { scopeId: "wf-huge" })[0];
    expect(call.error_class).toBe("invalid_response");
  });

  it("401 不自动重试：单次调用、auth 分类、中文配置提示", async () => {
    const transport = vi.fn(async () => errResponse(401, `Authorization: Bearer ${KEY}`));
    const client = makeClient(makeConfig(), transport);
    await expect(
      client.run({ context: ctx({ scopeId: "wf-401" }), model: "vision-x", messages: [], maxTokens: 2500, parse: visionParse }),
    ).rejects.toThrowError(AiProviderAuthError);
    expect(transport).toHaveBeenCalledTimes(1);
    const call = listAiCalls(db, { scopeId: "wf-401" })[0];
    expect(call.error_class).toBe("auth");
    expect(call.error_message).not.toContain(KEY);
  });
});

describe("超时与预算（V16/V17）", () => {
  it("超时：记录可能已受理、保守占额不可释放、不盲目重发", async () => {
    const transport = vi.fn(async () => {
      throw new DOMException("The operation timed out", "TimeoutError");
    });
    const client = makeClient(makeConfig(), transport);
    await expect(
      client.run({ context: ctx({ scopeId: "wf-timeout" }), model: "vision-x", messages: [], maxTokens: 2500, parse: visionParse }),
    ).rejects.toThrowError(AiTimeoutError);
    expect(transport).toHaveBeenCalledTimes(1);
    const call = listAiCalls(db, { scopeId: "wf-timeout" })[0];
    expect(call.status).toBe("failed");
    expect(call.error_class).toBe("timeout");
    expect(call.usage).toBeNull();
    // 已发出的名额保守占额：全局日计数仍为 1，且不可释放
    expect(getBudgetUsage(db, { scopeType: "global", scopeId: "*" })).toBeGreaterThanOrEqual(1);
    const sent = getAiCall(db, call.id)!;
    expect(sent.status).not.toBe("reserved");
  });

  it("日预算耗尽：本地拒绝不请求服务商，错误可读", async () => {
    // 独立库 + 独立日期：不与前面用例共享全局日计数器。
    const db2 = createDb(":memory:");
    const exh2 = createExhibition(db2, CreateExhibitionInput.parse({ title: "预算影展", allow_external_ai: true }), "ai").id;
    const transport = vi.fn(async () => okResponse(FACTS));
    const client = new AiClient(db2, makeConfig({ AI_MAX_CALLS_PER_DAY: 2 }), transport, async () => {}, () => new Date("2026-11-25T03:00:00.000Z"));
    const opts = {
      context: { purpose: "vision" as const, scopeType: "workflow" as const, scopeId: "wf-budget", exhibitionId: exh2, promptVersion: "vision-v1", schemaVersion: "visual-facts-v1", preprocessVersion: "prep-v1" },
      model: "vision-x",
      messages: [],
      maxTokens: 2500,
      parse: visionParse,
    };
    await client.run(opts);
    await client.run(opts);
    await expect(client.run(opts)).rejects.toThrowError(AiBudgetError);
    expect(transport).toHaveBeenCalledTimes(2);
    db2.close();
  });

  it("两个客户端竞争最后一个每日名额，只允许一个 transport 外发", async () => {
    const isolated = createDb(":memory:");
    try {
      const id = createExhibition(isolated, CreateExhibitionInput.parse({ allow_external_ai: true }), "ai").id;
      const transport = vi.fn(async () => okResponse(FACTS));
      const config = makeConfig({ AI_MAX_CALLS_PER_DAY: 1, AI_CACHE_ENABLED: false });
      const clients = [0, 1].map(() => new AiClient(isolated, config, transport, async () => {}, () => new Date("2026-11-25T03:00:00.000Z")));
      const results = await Promise.allSettled(clients.map((client, i) => client.run({
        context: ctx({ exhibitionId: id, scopeId: `wf-competing-${i}` }),
        model: "vision-x", messages: [], maxTokens: 2500, parse: visionParse,
      })));
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter(r => r.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(AiBudgetError);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(listAiCalls(isolated)).toHaveLength(1);
      expect(getBudgetUsage(isolated, { scopeType: "global" })).toBe(1);
    } finally { isolated.close(); }
  });

  it("网络错误：记录脱敏错误消息，不重试", async () => {
    const transport = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED key=${KEY}`);
    });
    const client = makeClient(makeConfig(), transport);
    await expect(
      client.run({ context: ctx({ scopeId: "wf-net" }), model: "vision-x", messages: [], maxTokens: 2500, parse: visionParse }),
    ).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
    const call = listAiCalls(db, { scopeId: "wf-net" })[0];
    expect(call.error_class).toBe("network");
    expect(call.error_message).not.toContain(KEY);
  });
});

describe("外发前置拒绝（V02/V04）", () => {
  it("配置缺失：抛中文配置错误，不发起请求", async () => {
    const transport = vi.fn(async () => okResponse(FACTS));
    const client = makeClient(loadAiConfig({} as NodeJS.ProcessEnv), transport);
    await expect(
      client.run({ context: ctx(), model: "vision-x", messages: [], maxTokens: 2500, parse: visionParse }),
    ).rejects.toThrowError(AiConfigError);
    expect(transport).not.toHaveBeenCalled();
  });

  it("未授权影展：外发前拒绝，不产生调用记录", async () => {
    const transport = vi.fn(async () => okResponse(FACTS));
    const demo = createExhibition(db, CreateExhibitionInput.parse({ title: "演示" }), "demo").id;
    const client = makeClient(makeConfig(), transport);
    await expect(
      client.run({ context: ctx({ exhibitionId: demo }), model: "vision-x", messages: [], maxTokens: 2500, parse: visionParse }),
    ).rejects.toThrowError(AiUnauthorizedError);
    expect(transport).not.toHaveBeenCalled();
    expect(listAiCalls(db, { exhibitionId: demo }).length).toBe(0);
  });

  it("连接测试：合法上下文可运行（固定无私密内容由受保护端点负责，阶段 F）", async () => {
    const transport = vi.fn(async () => okResponse(FACTS));
    const client = makeClient(makeConfig({ AI_CONNECTION_TEST_LIMIT_PER_HOUR: 5 }), transport);
    const r = await client.run({
      context: {
        purpose: "connection_test",
        scopeType: "connection_test",
        scopeId: "ct",
        exhibitionId: null,
        promptVersion: "conn-v1",
        schemaVersion: "conn-v1",
      },
      model: "vision-x",
      messages: [{ role: "user", content: "测试连接，无隐私内容" }],
      maxTokens: 50,
      parse: visionParse,
    });
    expect(r.source).toBe("fresh");
    const calls = listAiCalls(db, { scopeType: "connection_test" });
    expect(calls.length).toBe(1);
    expect(calls[0].exhibition_id).toBeNull();
  });
});

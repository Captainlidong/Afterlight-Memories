import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { createDb } from "@/lib/db/client";
import { loadAiConfig, type AiConfig } from "@/lib/ai/config";
import { runAiConnectionTest } from "@/lib/ai/connectionTest";
import { CONNECTION_PROBE_AGENTS, connectionSchemaVersion, getAiConnectionStatus } from "@/lib/ai/status";
import { createAiCall, listAiCalls, updateAiCall } from "@/lib/ai/records";
import { getBudgetUsage } from "@/lib/ai/budget";

const config = loadAiConfig({
  NODE_ENV: "test", AI_API_KEY: "synthetic-private-key", AI_BASE_URL: "https://mock.invalid/v1",
  AI_TEXT_MODEL: "mock-text", AI_VISION_MODEL: "mock-vision", AI_MAX_RETRIES: "3",
  AI_CONNECTION_TEST_LIMIT_PER_HOUR: "60",
});
const response = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }));
const successTransport = () => vi.fn().mockResolvedValueOnce(response("AFTERLIGHT_OK")).mockResolvedValueOnce(response("红色"));
let db: DatabaseSync;
beforeEach(() => { db = createDb(":memory:"); });
afterEach(() => { db.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function record(scopeId: string, capability: "text" | "vision" | null, status = "succeeded", schemaVersion = connectionSchemaVersion(config)) {
  const row = createAiCall(db, {
    scopeId, scopeType: "connection_test", purpose: "connection_test", exhibitionId: null,
    provider: config.provider, model: "mock", schemaVersion,
    agentType: capability && CONNECTION_PROBE_AGENTS[capability], createdAt: "2026-11-01T00:00:00.000Z",
  });
  updateAiCall(db, row.id, { status: status as "succeeded" | "failed" | "sent" });
  return row;
}

describe("connection probes (mock transport only)", () => {
  it("sends only two fixed bodies, a locally generated red JPEG, and records one shared scope", async () => {
    const transport = successTransport();
    const results = await runAiConnectionTest(db, config, transport);
    expect(transport).toHaveBeenCalledTimes(2);
    const bodies = transport.mock.calls.map(([, init]) => JSON.parse(String(init.body)));
    expect(bodies[0]).toEqual({ model: "mock-text", max_tokens: 32, messages: [
      { role: "user", content: "Reply with exactly AFTERLIGHT_OK and nothing else." },
    ] });
    const image = bodies[1].messages[0].content[1].image_url.url as string;
    expect(bodies[1]).toEqual({ model: "mock-vision", max_tokens: 32, messages: [
      { role: "user", content: [
        { type: "text", text: "What is the dominant color in this image? Reply with only one color name in English or Chinese." },
        { type: "image_url", image_url: { url: image } },
      ] },
    ] });
    expect(image).toMatch(/^data:image\/jpeg;base64,/);
    const bytes = Buffer.from(image.split(",")[1], "base64");
    const metadata = await sharp(bytes).metadata();
    expect(metadata).toMatchObject({ format: "jpeg", width: 16, height: 16 });
    expect(metadata.exif).toBeUndefined();
    const { data } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length; i += 3) {
      expect(data[i]).toBeGreaterThan(245); expect(data[i + 1]).toBeLessThan(10); expect(data[i + 2]).toBeLessThan(10);
    }
    expect(JSON.stringify(bodies)).not.toContain(config.apiKey);
    expect(results.text.state).toBe("succeeded"); expect(results.vision.state).toBe("succeeded");
    const calls = listAiCalls(db);
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((r) => r.scope_id)).size).toBe(1);
    expect(calls.every((r) => r.exhibition_id === null && r.purpose === "connection_test" && r.attempt === 1)).toBe(true);
    expect(calls.every((r) => r.schema_version === connectionSchemaVersion(config))).toBe(true);
    expect(getBudgetUsage(db, { scopeType: "global" })).toBe(2);
    expect(getAiConnectionStatus(db, config)).toMatchObject({ kind: "test_succeeded", lastTestOk: true });
    for (const secret of [config.apiKey!, config.baseUrl!, config.textModel!, config.visionModel!]) {
      expect(JSON.stringify({ results, status: getAiConnectionStatus(db, config) })).not.toContain(secret);
      expect(connectionSchemaVersion(config)).not.toContain(secret);
    }
    expect(config.maxRetries).toBe(3);
  });

  it.each(["https://api.deepseek.com", "https://api.deepseek.com/v1/"])("DeepSeek fixed probes disable thinking without increasing tokens or retries: %s", async (baseUrl) => {
    const deepseek = loadAiConfig({
      NODE_ENV: "test", AI_API_KEY: "synthetic-private-key", AI_BASE_URL: baseUrl,
      AI_VISION_MODEL: "deepseek-flash", AI_MAX_RETRIES: "3",
    });
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.thinking?.type !== "disabled") return response("");
      return response(Array.isArray(body.messages[0].content) ? "red" : "AFTERLIGHT_OK");
    });
    const results = await runAiConnectionTest(db, deepseek, transport);
    expect(results.text.state).toBe("succeeded");
    expect(results.vision.state).toBe("succeeded");
    expect(transport).toHaveBeenCalledTimes(2);
    const bodies = transport.mock.calls.map(([, init]) => JSON.parse(String(init.body)));
    for (const body of bodies) {
      expect(body).toMatchObject({ model: "deepseek-flash", max_tokens: 32, thinking: { type: "disabled" } });
      expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model", "thinking"]);
    }
    expect(bodies[1].messages[0].content[1].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(listAiCalls(db)).toHaveLength(2);
    expect(getBudgetUsage(db, { scopeType: "global" })).toBe(2);
    expect(getBudgetUsage(db, { scopeType: "job" })).toBe(0);
    expect(getAiConnectionStatus(db, deepseek).lastTestOk).toBe(true);
  });

  it.each([401, 403, 402, 429])("stops after text auth/quota failure (%s)", async (status) => {
    const transport = vi.fn(async () => new Response("insufficient_quota private-upstream-error", { status }));
    const results = await runAiConnectionTest(db, config, transport);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(results.text.state).toBe("failed"); expect(results.vision.state).toBe("untested");
    expect(results.vision.message).toBeTruthy();
    expect(getAiConnectionStatus(db, config).lastTestOk).toBe(false);
    expect(JSON.stringify(results)).not.toContain("private-upstream-error");
  });

  it.each(["invalid", "transient", "network", "timeout"])("never retries %s even with maxRetries=3", async (failure) => {
    const transport = vi.fn(async () => {
      if (failure === "network") throw new Error("private-url-or-error");
      if (failure === "timeout") throw new DOMException("private-timeout", "AbortError");
      return failure === "transient" ? new Response("unavailable", { status: 503 }) : response("AFTERLIGHT_OK but wrong");
    });
    const results = await runAiConnectionTest(db, config, transport);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(listAiCalls(db)).toHaveLength(2);
    expect(results.text.state).toBe("failed"); expect(results.vision.state).toBe("failed");
    expect(JSON.stringify(results)).not.toContain("private-");
  });

  it.each(["blue", "not red", "red and blue", "AFTERLIGHT_OK"])("does not report full success for vision output %s", async (color) => {
    const transport = vi.fn().mockResolvedValueOnce(response("AFTERLIGHT_OK")).mockResolvedValueOnce(response(color));
    const results = await runAiConnectionTest(db, config, transport);
    expect(results.text.state).toBe("succeeded"); expect(results.vision.state).toBe("failed");
    expect(getAiConnectionStatus(db, config)).toMatchObject({ kind: "connection_error", lastTestOk: false });
  });

  it.each(["maxCallsPerDay", "connectionTestLimitPerHour"] as const)("honors %s, including failure before any send", async (field) => {
    const limited = { ...config, [field]: 1 };
    const transport = successTransport();
    const first = await runAiConnectionTest(db, limited, transport);
    expect(first.text.state).toBe("succeeded"); expect(first.vision.state).toBe("failed");
    expect(first.vision.message).toBeTruthy();
    const second = await runAiConnectionTest(db, limited, transport);
    expect(second.text.state).toBe("failed"); expect(second.text.message).toBeTruthy();
    expect(second.vision.state).toBe("untested");
    expect(transport).toHaveBeenCalledTimes(1); expect(listAiCalls(db)).toHaveLength(1);
    expect(getAiConnectionStatus(db, limited).lastTestOk).not.toBe(true);
  });

  it.each([{ accessMode: "public" }, { configured: false }, { issues: ["private-invalid-timezone"] }] as Partial<AiConfig>[])("fails closed before direct execution: %j", async (override) => {
    const transport = successTransport();
    const invalid = { ...config, ...override };
    await expect(runAiConnectionTest(db, invalid, transport)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled(); expect(listAiCalls(db)).toHaveLength(0);
    expect(getAiConnectionStatus(db, invalid).canTest).toBe(false);
    expect(JSON.stringify(getAiConnectionStatus(db, invalid))).not.toContain("private-invalid-timezone");
  });
});

describe("read-only fingerprinted status", () => {
  it("requires labeled text and vision from the same latest attempt, not legacy or separate scopes", () => {
    record("legacy", null);
    expect(getAiConnectionStatus(db, config).lastTestOk).toBeNull();
    record("text-only", "text");
    expect(getAiConnectionStatus(db, config).capabilities.vision.state).toBe("untested");
    expect(getAiConnectionStatus(db, config).lastTestOk).not.toBe(true);
    record("vision-only", "vision");
    expect(getAiConnectionStatus(db, config).lastTestOk).not.toBe(true);
    record("full", "text"); record("full", "vision");
    expect(getAiConnectionStatus(db, config).lastTestOk).toBe(true);
    record("new", "text", "failed");
    expect(getAiConnectionStatus(db, config)).toMatchObject({ lastTestOk: false, capabilities: { vision: { state: "untested" } } });
  });

  it("reports running, and late completion of an older scope cannot replace the newest attempt", () => {
    record("older", "text"); record("newer", "text", "sent"); record("older", "vision");
    expect(getAiConnectionStatus(db, config)).toMatchObject({ lastTestOk: null, capabilities: { text: { state: "running" }, vision: { state: "untested" } } });
  });

  it("invalidates every fingerprint component and ignores probe versions and unrelated recent records", () => {
    record("full", "text"); record("full", "vision");
    for (const override of [
      { apiKey: "different-key" }, { baseUrl: "https://different.invalid/v1" }, { textModel: "different-text" },
      { visionModel: "different-vision" }, { provider: "different-provider" },
    ]) {
      expect(getAiConnectionStatus(db, { ...config, ...override } as AiConfig).lastTestOk).toBeNull();
    }
    record("old-version", "text", "succeeded", "connection-smoke-v0");
    for (let i = 0; i < 110; i++) record(`other-${i}`, "text", "succeeded", "other-fingerprint");
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const before = listAiCalls(db).length;
    for (let i = 0; i < 5; i++) expect(getAiConnectionStatus(db, config).lastTestOk).toBe(true);
    expect(listAiCalls(db)).toHaveLength(before); expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never exposes invalid timezone text, stored provider messages or unknown error classes", () => {
    const row = record("failed", "text", "failed");
    updateAiCall(db, row.id, { error_class: "private-class", error_message: "private-message" });
    const invalid = loadAiConfig({ NODE_ENV: "test", AI_DAY_TIMEZONE: "private-timezone" });
    expect(JSON.stringify(getAiConnectionStatus(db, invalid))).not.toContain("private-timezone");
    expect(JSON.stringify(getAiConnectionStatus(db, config))).not.toContain("private-");
  });
});

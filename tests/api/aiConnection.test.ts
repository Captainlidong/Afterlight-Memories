import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { createDb, getDb } from "@/lib/db/client";
import { loadAiConfig, type AiConfig } from "@/lib/ai/config";
import { assertLocalMutation } from "@/lib/api/localRequest";
import { ApiError } from "@/lib/api/errors";
import { resolveMode } from "@/lib/mode";
import { listAiCalls } from "@/lib/ai/records";
import { GET } from "@/app/api/ai/status/route";
import { POST } from "@/app/api/ai/connection-test/route";

// No author database, process environment or real model transport is used.
vi.mock("@/lib/db/client", async (original) => ({ ...await original<object>(), getDb: vi.fn() }));
vi.mock("@/lib/ai/config", async (original) => ({ ...await original<object>(), loadAiConfig: vi.fn() }));
vi.mock("@/lib/api/localRequest", () => ({ assertLocalMutation: vi.fn() }));
vi.mock("@/lib/mode", () => ({ resolveMode: vi.fn(() => "demo") }));

const config: AiConfig = {
  provider: "openai-compatible", apiKey: "synthetic-api-key", baseUrl: "https://mock.invalid/v1",
  textModel: "private-text-model", visionModel: "private-vision-model", configured: true, issues: [], missing: [],
  accessMode: "local", imageMaxEdge: 1280, maxPhotosPerJob: 30, maxConcurrency: 2,
  requestTimeoutMs: 1000, maxRetries: 3, maxOutputTokens: 100, maxCallsPerJob: 40,
  maxCallsPerDay: 100, connectionTestLimitPerHour: 5, dayTimezone: "Asia/Shanghai", cacheEnabled: true,
  rateLimit: { enabled: true, tasksPerIpPerMinute: 2, tasksPerIpPerDay: 5, tasksPerUserPerDay: 5 },
};
const response = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }));
let db: DatabaseSync;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  db = createDb(":memory:");
  vi.mocked(getDb).mockReturnValue(db);
  vi.mocked(loadAiConfig).mockReturnValue({ ...config });
  vi.mocked(assertLocalMutation).mockReset();
  fetchMock = vi.fn().mockRejectedValue(new Error("Unexpected mock request"));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { db.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function request(body: unknown = { confirmed: true }, contentType = "application/json") {
  return new Request("http://localhost:3000/api/ai/connection-test", {
    method: "POST", headers: { "content-type": contentType, origin: "http://localhost:3000" }, body: JSON.stringify(body),
  });
}

describe("AI connection routes", () => {
  it("repeated GET is no-store, read-only, and never initiates a probe", async () => {
    for (let i = 0; i < 5; i++) {
      const result = await GET();
      expect(result.headers.get("cache-control")).toBe("no-store");
      expect(await result.json()).toMatchObject({ defaultMode: "demo", connection: { canTest: true, lastTestOk: null } });
    }
    expect(fetchMock).not.toHaveBeenCalled(); expect(assertLocalMutation).not.toHaveBeenCalled();
    expect(listAiCalls(db)).toHaveLength(0); expect(resolveMode).toHaveBeenCalledTimes(5);
  });

  it("confirmed local POST uses only server-owned prompts and an in-memory JPEG, GET reuses records", async () => {
    fetchMock.mockResolvedValueOnce(response("AFTERLIGHT_OK")).mockResolvedValueOnce(response("red"));
    const req = request({ confirmed: true }, "application/json; charset=utf-8");
    const result = await POST(req);
    expect(assertLocalMutation).toHaveBeenCalledWith(req);
    expect(vi.mocked(assertLocalMutation).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(getDb).mock.invocationCallOrder[0]);
    expect(result.status).toBe(200);
    const body = await result.json();
    expect(body).toMatchObject({ connection: { lastTestOk: true }, results: { text: { state: "succeeded" }, vision: { state: "succeeded" } } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requests = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init.body)));
    expect(requests[0].messages).toEqual([{ role: "user", content: "Reply with exactly AFTERLIGHT_OK and nothing else." }]);
    expect(requests[1].messages[0].content[0].text).not.toMatch(/red|红色/i);
    const image = Buffer.from(requests[1].messages[0].content[1].image_url.url.split(",")[1], "base64");
    expect(await sharp(image).metadata()).toMatchObject({ format: "jpeg", width: 16, height: 16 });
    const { channels } = await sharp(image).stats();
    expect(channels[0].min).toBeGreaterThan(245); expect(channels[1].max).toBeLessThan(10); expect(channels[2].max).toBeLessThan(10);
    for (const secret of [config.apiKey!, config.baseUrl!, config.textModel!, config.visionModel!]) expect(JSON.stringify(body)).not.toContain(secret);
    for (let i = 0; i < 3; i++) expect((await (await GET()).json()).connection.lastTestOk).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2); expect(listAiCalls(db)).toHaveLength(2);
  });

  it.each([{}, null, [], false, { confirmed: false }, { confirmed: "true" },
    { confirmed: true, model: "private-input" }, { confirmed: true, url: "https://private.invalid" },
    { confirmed: true, image: "private-image" }, { confirmed: true, purpose: "connection_test" },
    { confirmed: true, messages: ["private-message"] }, { confirmed: true, "private-key-name": "value" },
  ])("rejects anything other than exact confirmation: %j", async (body) => {
    const result = await POST(request(body));
    expect(result.status).toBe(400);
    expect(JSON.stringify(await result.json())).not.toContain("private-");
    expect(getDb).not.toHaveBeenCalled(); expect(loadAiConfig).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and non-JSON content types before database access", async () => {
    const malformed = new Request("http://localhost/api/ai/connection-test", { method: "POST", headers: { "content-type": "application/json" }, body: "{bad" });
    expect((await POST(malformed)).status).toBe(400);
    expect((await POST(request({ confirmed: true }, "text/plain"))).status).toBe(415);
    expect(getDb).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honors shared guard rejection before parsing, config or database access", async () => {
    vi.mocked(assertLocalMutation).mockImplementation(() => { throw new ApiError(403, "untrusted_origin", "仅允许本机同源请求。"); });
    const req = request(); const parse = vi.spyOn(req, "json");
    const result = await POST(req);
    expect(result.status).toBe(403); expect((await result.json()).error.code).toBe("untrusted_origin");
    expect(parse).not.toHaveBeenCalled(); expect(loadAiConfig).not.toHaveBeenCalled();
    expect(getDb).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { override: { accessMode: "public" }, status: 403, code: "ai_unauthorized" },
    { override: { issues: ["private-invalid-timezone"] }, status: 503, code: "ai_config" },
    { override: { configured: false }, status: 503, code: "ai_config" },
  ] as { override: Partial<AiConfig>; status: number; code: string }[])("fails closed even if the guard allowed the request: $code", async ({ override, status, code }) => {
    vi.mocked(loadAiConfig).mockReturnValue({ ...config, ...override });
    const result = await POST(request());
    expect(result.status).toBe(status);
    const body = await result.json();
    expect(body.error.code).toBe(code); expect(JSON.stringify(body)).not.toContain("private-");
    expect(fetchMock).not.toHaveBeenCalled(); expect(listAiCalls(db)).toHaveLength(0);
    expect((await (await GET()).json()).connection.canTest).toBe(false);
  });

  it("reports a pre-send budget failure explicitly, without manufacturing request records", async () => {
    vi.mocked(loadAiConfig).mockReturnValue({ ...config, maxCallsPerDay: 1 });
    fetchMock.mockResolvedValueOnce(response("AFTERLIGHT_OK"));
    const first = await (await POST(request())).json();
    expect(first.connection.lastTestOk).not.toBe(true);
    expect(first.results).toMatchObject({ text: { state: "succeeded" }, vision: { state: "failed" } });
    const second = await (await POST(request())).json();
    expect(second.results.text).toMatchObject({ state: "failed", message: expect.any(String) });
    expect(second.results.text.message.length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(listAiCalls(db)).toHaveLength(1);
  });

  it("does not reuse earlier success when the new click is denied before sending", async () => {
    vi.mocked(loadAiConfig).mockReturnValue({ ...config, maxCallsPerDay: 2 });
    fetchMock.mockResolvedValueOnce(response("AFTERLIGHT_OK")).mockResolvedValueOnce(response("red"));
    expect((await (await POST(request())).json()).connection.lastTestOk).toBe(true);
    const denied = await (await POST(request())).json();
    expect(denied.connection.lastTestOk).toBe(false);
    expect(denied.connection.lastTestErrorClass).toBe("budget");
    expect(denied.connection.capabilities.text.state).toBe("failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("does not reflect upstream errors or falsely report a partial test as full success", async () => {
    fetchMock.mockResolvedValueOnce(response("AFTERLIGHT_OK")).mockResolvedValueOnce(new Response("private-upstream-details", { status: 401 }));
    const result = await (await POST(request())).json();
    expect(result.connection).toMatchObject({ lastTestOk: false, capabilities: { text: { state: "succeeded" }, vision: { state: "failed" } } });
    expect(JSON.stringify(result)).not.toContain("private-upstream-details");
  });
});

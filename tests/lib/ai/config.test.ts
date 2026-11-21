import { describe, it, expect } from "vitest";
import { loadAiConfig, assertUsable, chatCompletionsUrl, resolveTextModel } from "@/lib/ai/config";
import { AiConfigError } from "@/lib/ai/errors";

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv;
}

describe("loadAiConfig：服务端配置校验（任务书 §4.1）", () => {
  it("空环境：未配置、默认数值全部在合法范围、无密钥泄漏", () => {
    const c = loadAiConfig(env());
    expect(c.configured).toBe(false);
    expect(c.missing).toEqual(["AI_API_KEY", "AI_BASE_URL", "AI_VISION_MODEL"]);
    expect(c.provider).toBe("openai-compatible");
    expect(c.imageMaxEdge).toBe(1280);
    expect(c.maxConcurrency).toBe(2);
    expect(c.requestTimeoutMs).toBe(60_000);
    expect(c.maxRetries).toBe(1);
    expect(c.maxCallsPerJob).toBe(40);
    expect(c.maxCallsPerDay).toBe(100);
    expect(c.cacheEnabled).toBe(true);
    expect(c.accessMode).toBe("local");
    expect(JSON.stringify(c)).not.toContain("sk-");
  });

  it("必填齐全即 configured；AI_TEXT_MODEL 缺省复用视觉模型", () => {
    const c = loadAiConfig(
      env({
        AI_API_KEY: "sk-test-123456",
        AI_BASE_URL: "https://api.example.com/v1",
        AI_VISION_MODEL: "vision-x",
      }),
    );
    expect(c.configured).toBe(true);
    expect(c.missing).toEqual([]);
    expect(c.issues).toEqual([]);
    expect(resolveTextModel(c)).toBe("vision-x");
    expect(c.textModel).toBeNull();
  });

  it("base URL 归一化：去除尾斜杠，拼接固定接口路径不重复 /v1", () => {
    const c = loadAiConfig(
      env({
        AI_API_KEY: "sk-test-123456",
        AI_BASE_URL: "https://api.example.com/v1////",
        AI_VISION_MODEL: "v",
      }),
    );
    expect(c.baseUrl).toBe("https://api.example.com/v1");
    expect(chatCompletionsUrl(c)).toBe("https://api.example.com/v1/chat/completions");
  });

  it("非本地模型服务必须 HTTPS；localhost 允许 http", () => {
    const httpRemote = loadAiConfig(
      env({ AI_API_KEY: "k", AI_BASE_URL: "http://api.example.com/v1", AI_VISION_MODEL: "v" }),
    );
    expect(httpRemote.issues.some((i) => i.includes("HTTPS"))).toBe(true);
    expect(httpRemote.baseUrl).toBeNull();

    const httpLocal = loadAiConfig(
      env({ AI_API_KEY: "k", AI_BASE_URL: "http://localhost:8080/v1", AI_VISION_MODEL: "v" }),
    );
    expect(httpLocal.issues).toEqual([]);
    expect(httpLocal.baseUrl).toBe("http://localhost:8080/v1");
  });

  it("非法数值被拒绝并回落默认值，且记录中文问题（不能变成无限）", () => {
    const c = loadAiConfig(
      env({
        AI_API_KEY: "k",
        AI_BASE_URL: "https://api.example.com/v1",
        AI_VISION_MODEL: "v",
        AI_MAX_RETRIES: "99",
        AI_MAX_CONCURRENCY: "0",
        AI_MAX_CALLS_PER_DAY: "-5",
        AI_IMAGE_MAX_EDGE: "99999",
        AI_REQUEST_TIMEOUT_MS: "abc",
      }),
    );
    expect(c.maxRetries).toBe(1);
    expect(c.maxConcurrency).toBe(2);
    expect(c.maxCallsPerDay).toBe(100);
    expect(c.imageMaxEdge).toBe(1280);
    expect(c.requestTimeoutMs).toBe(60_000);
    expect(c.issues.length).toBeGreaterThanOrEqual(5);
  });

  it("无效时区回落默认时区并给出问题", () => {
    const c = loadAiConfig(
      env({
        AI_API_KEY: "k",
        AI_BASE_URL: "https://api.example.com/v1",
        AI_VISION_MODEL: "v",
        AI_DAY_TIMEZONE: "Not/AZone",
      }),
    );
    expect(c.dayTimezone).toBe("Asia/Shanghai");
    expect(c.issues.some((i) => i.includes("AI_DAY_TIMEZONE"))).toBe(true);
  });

  it("只支持 openai-compatible 协议", () => {
    const c = loadAiConfig(
      env({
        AI_API_KEY: "k",
        AI_BASE_URL: "https://api.example.com/v1",
        AI_VISION_MODEL: "v",
        AI_PROVIDER: "anthropic",
      }),
    );
    expect(c.issues.some((i) => i.includes("openai-compatible"))).toBe(true);
  });

  it("public 访问模式必须启用限流（任务书 §9.2）", () => {
    const c = loadAiConfig(
      env({
        AFTERLIGHT_ACCESS_MODE: "public",
        RATE_LIMIT_ENABLED: "false",
      }),
    );
    expect(c.accessMode).toBe("public");
    expect(c.issues.some((i) => i.includes("RATE_LIMIT_ENABLED"))).toBe(true);
  });

  it("assertUsable：未配置/无效时抛中文错误，错误不含密钥与地址", () => {
    expect(() => assertUsable(loadAiConfig(env()))).toThrowError(AiConfigError);
    try {
      assertUsable(loadAiConfig(env()));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      expect(msg).toContain("AI_API_KEY");
      expect(msg).toContain("演示模式不受影响");
      expect(msg).not.toContain("sk-");
    }
  });
});

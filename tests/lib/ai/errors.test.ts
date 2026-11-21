import { describe, it, expect } from "vitest";
import {
  desensitize,
  parseRetryAfter,
  backoffMs,
  AiProviderAuthError,
  AiProviderQuotaError,
  AiTransientError,
  AiProviderError,
} from "@/lib/ai/errors";
import { classifyProviderError } from "@/lib/ai/client";

function resp(status: number, body = "", headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

describe("错误分类与脱敏（任务书 §7.4 / §8.1）", () => {
  it("desensitize 去除密钥与 Authorization 头", () => {
    const secret = "sk-abcdef1234567890";
    const out = desensitize(`url=https://x/v1?key=${secret} Authorization: Bearer ${secret}`, [secret]);
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED]");
  });

  it("parseRetryAfter：秒数、HTTP 日期、非法值", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter("0")).toBe(200);
    expect(parseRetryAfter("abc")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
    const future = new Date(Date.now() + 5000).toUTCString();
    expect(parseRetryAfter(future)).toBeGreaterThan(0);
    // 超大秒数封顶 30s，避免无界等待
    expect(parseRetryAfter("999999")).toBe(30_000);
  });

  it("backoffMs：有界退避，尊重 Retry-After", () => {
    expect(backoffMs(1, null)).toBe(500);
    expect(backoffMs(4, null)).toBe(4000);
    expect(backoffMs(20, null)).toBe(8000);
    expect(backoffMs(1, 250)).toBe(250);
  });

  it("401/403 → auth，不自动重试", () => {
    const e = classifyProviderError(resp(401), "");
    expect(e).toBeInstanceOf(AiProviderAuthError);
    expect(e.retryable).toBe(false);
    const e2 = classifyProviderError(resp(403), "");
    expect(e2).toBeInstanceOf(AiProviderAuthError);
  });

  it("402 / 429 insufficient_quota → quota，停止新增外发", () => {
    expect(classifyProviderError(resp(402), "")).toBeInstanceOf(AiProviderQuotaError);
    const body = '{"error":{"message":"insufficient_quota"}}';
    const e = classifyProviderError(resp(429, body), body);
    expect(e).toBeInstanceOf(AiProviderQuotaError);
    expect(e.retryable).toBe(false);
  });

  it("429 限流 / 5xx → transient 可重试，尊重 Retry-After", () => {
    const e = classifyProviderError(resp(429, "rate limited", { "retry-after": "2" }), "rate limited");
    expect(e).toBeInstanceOf(AiTransientError);
    expect(e.retryable).toBe(true);
    expect(e.retryAfterMs).toBe(2000);
    expect(classifyProviderError(resp(503), "")).toBeInstanceOf(AiTransientError);
  });

  it("3xx 重定向 → 拒绝跟随（防止转发到未知主机）", () => {
    const e = classifyProviderError(resp(302, "", { location: "http://evil.example/" }), "");
    expect(e).toBeInstanceOf(AiProviderError);
    expect(e.retryable).toBe(false);
  });

  it("分类消息脱敏：服务商原文与密钥不进入错误", () => {
    const secret = "sk-secret-abcdef123456";
    const e = classifyProviderError(resp(500, `Authorization: Bearer ${secret}`), "", [secret]);
    expect(e.message).not.toContain(secret);
    expect(e.message).not.toContain("Bearer");
  });
});

import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AiError } from "../ai/errors";
import { AI_ERROR_GUIDANCE } from "../ai/feedback";

/** 统一错误信封：{ error: { code, message, details? } } */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** AI 适配器尚未接入模型时抛出；编排器捕获后转为 stage_failed + 友好提示。 */
export class AdapterNotConfiguredError extends Error {
  constructor(message = "AI 适配器尚未接入模型。请切换回演示模式，或配置视觉/文本适配器。") {
    super(message);
    this.name = "AdapterNotConfiguredError";
  }
}

export class ConcurrentRunError extends Error {
  constructor(message = "该影展已有正在运行的策展任务，请等待完成后再试。") {
    super(message);
    this.name = "ConcurrentRunError";
  }
}

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof AiError) {
    const status = err.cls === "budget" ? 429 : err.cls === "unauthorized" ? 403 : err.cls === "config" ? 503 : 502;
    return NextResponse.json(
      { error: { code: `ai_${err.cls}`, message: AI_ERROR_GUIDANCE[err.cls] } },
      { status, headers: err.retryAfterMs ? { "Retry-After": String(Math.ceil(err.retryAfterMs / 1000)) } : undefined },
    );
  }
  if (err instanceof SyntaxError) {
    return NextResponse.json({ error: { code: "invalid_json", message: "请求内容不是合法 JSON。" } }, { status: 400 });
  }
  if (err instanceof ApiError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message, details: err.details } },
      { status: err.status },
    );
  }
  if (err instanceof AdapterNotConfiguredError) {
    return NextResponse.json(
      { error: { code: "adapter_not_configured", message: err.message } },
      { status: 501 },
    );
  }
  if (err instanceof ConcurrentRunError) {
    return NextResponse.json(
      { error: { code: "concurrent_run", message: err.message } },
      { status: 409 },
    );
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "validation_error",
          message: "请求或数据未通过校验。",
          details: err.issues,
        },
      },
      { status: 400 },
    );
  }
  console.error("[afterlight] internal_error");
  return NextResponse.json(
    { error: { code: "internal_error", message: "操作未完成，请重试；已保存的内容仍在。" } }, 
    { status: 500 },
  );
}

/** 包裹 Route Handler，统一捕获错误为信封格式。 */
export function handler<A extends unknown[]>(
  fn: (...args: A) => Promise<NextResponse> | NextResponse,
) {
  return async (...args: A): Promise<NextResponse> => {
    try {
      return await fn(...args);
    } catch (err) {
      return errorResponse(err);
    }
  };
}
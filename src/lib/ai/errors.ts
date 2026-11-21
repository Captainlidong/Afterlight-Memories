/**
 * 外部模型调用的错误分类与脱敏（任务书 v3 §7.4 / §8.1）。
 * 分类决定系统行为：外发前拒绝（config/unauthorized/budget）不重试；
 * 服务商 401/403（auth）与余额/配额（quota）不自动重试；
 * 只有瞬态错误（429 限流、5xx）有界重试；超时默认不盲目重发，保守占额。
 * 任何错误消息与日志都不得携带 Key、Authorization 头或未经脱敏的服务商原文。
 */
export type AiErrorClass =
  | "config"
  | "unauthorized"
  | "budget"
  | "auth"
  | "quota"
  | "transient"
  | "timeout"
  | "invalid_response"
  | "provider"
  | "network"
  | "cancelled"
  | "queue"
  | "stale_context"
  | "invalid_reference";

export class AiError extends Error {
  readonly cls: AiErrorClass;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly details?: unknown;

  constructor(
    cls: AiErrorClass,
    message: string,
    opts: { retryable?: boolean; status?: number; retryAfterMs?: number; details?: unknown } = {},
  ) {
    super(message);
    this.name = "AiError";
    this.cls = cls;
    this.retryable = opts.retryable ?? false;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.details = opts.details;
  }
}

/** 配置缺失/无效：外发前失败，作者补齐配置；Demo 不受影响。 */
export class AiConfigError extends AiError {
  constructor(message: string, details?: unknown) {
    super("config", message, { details });
    this.name = "AiConfigError";
  }
}

/** 未授权（模式不是 ai / 未勾选外部授权 / 影展归属无效）：外发前拒绝，不静默回退 Demo。 */
export class AiUnauthorizedError extends AiError {
  constructor(message: string) {
    super("unauthorized", message);
    this.name = "AiUnauthorizedError";
  }
}

/** 本系统任务/日/连接测试预算超限：本地拒绝，不请求服务商。 */
export class AiBudgetError extends AiError {
  constructor(message: string, details?: unknown) {
    super("budget", message, { details });
    this.name = "AiBudgetError";
  }
}

/** 服务商密钥无效 / 模型不存在 / 无权限（401/403）：不自动重试。 */
export class AiProviderAuthError extends AiError {
  constructor(message: string, status?: number) {
    super("auth", message, { status });
    this.name = "AiProviderAuthError";
  }
}

/** 服务商余额/配额耗尽：停止新增外发。 */
export class AiProviderQuotaError extends AiError {
  constructor(message: string, status?: number) {
    super("quota", message, { status });
    this.name = "AiProviderQuotaError";
  }
}

/** 可重试的瞬态错误（429 限流 / 5xx），尊重 Retry-After。 */
export class AiTransientError extends AiError {
  constructor(message: string, opts: { status?: number; retryAfterMs?: number | null } = {}) {
    super("transient", message, {
      retryable: true,
      status: opts.status,
      retryAfterMs: opts.retryAfterMs ?? undefined,
    });
    this.name = "AiTransientError";
  }
}

/** 请求超时/响应丢失：服务商可能已受理并计费，按未知结果保守占额，默认不自动重发。 */
export class AiTimeoutError extends AiError {
  constructor(message = "模型服务响应超时。本次请求可能已被受理，未自动重发；已保存的作品不受影响。") {
    super("timeout", message);
    this.name = "AiTimeoutError";
  }
}

/** 响应不是合法 JSON / 结构校验失败：结果不落库，最多追加一次格式修复（阶段 E）。 */
export class AiInvalidResponseError extends AiError {
  constructor(message = "模型返回的内容不是预期的结构化结果。", details?: unknown) {
    super("invalid_response", message, { details });
    this.name = "AiInvalidResponseError";
  }
}

/** 业务引用校验失败：不是格式错误，不自动修复，也不删除其他上下文的有效缓存。 */
export class AiBusinessValidationError extends AiError {
  constructor() {
    super("invalid_reference", "模型结果的业务引用未通过校验，未发布到作品。");
    this.name = "AiBusinessValidationError";
  }
}

export class AiCancelledError extends AiError {
  constructor() {
    super("cancelled", "模型请求已取消；已发送请求可能已被受理，未自动重发。");
    this.name = "AiCancelledError";
  }
}

export class AiQueueError extends AiError {
  constructor() {
    super("queue", "模型请求队列已满或等待超时，本次排队未外发。");
    this.name = "AiQueueError";
  }
}

export class AiStaleContextError extends AiError {
  constructor() {
    super("stale_context", "任务或输入已失效，已停止请求与结果发布。");
    this.name = "AiStaleContextError";
  }
}

/** 其他服务商/网络错误（无法归类）：不自动重试。 */
export class AiProviderError extends AiError {
  constructor(message: string, opts: { status?: number } = {}) {
    super("provider", message, { status: opts.status });
    this.name = "AiProviderError";
  }
}

export class AiNetworkError extends AiError {
  constructor(message = "无法连接模型服务，请检查网络后重试。") {
    super("network", message);
    this.name = "AiNetworkError";
  }
}

/** 从任意文本中去除 Key 与凭据类内容（错误消息、日志、调用记录统一经过此函数）。 */
export function desensitize(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 8) out = out.split(s).join("[REDACTED]");
  }
  out = out.replace(/authorization\s*:\s*bearer\s+\S+/gi, "Authorization: Bearer [REDACTED]");
  out = out.replace(/\b(sk|key|api[-_]?key|token)\b[\s:=]+[A-Za-z0-9_\-./+]{12,}/gi, "$1=[REDACTED]");
  return out;
}

/** 解析 Retry-After：秒数或 HTTP 日期；无法解析返回 null。 */
export function parseRetryAfter(value: string | null, nowMs = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(Math.min(Math.max(seconds, 0.2), 30) * 1000);
  }
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) {
    return Math.min(Math.max(date - nowMs, 0), 30_000);
  }
  return null;
}

/** 有界指数退避（重试间隔），封顶 8 秒。 */
export function backoffMs(attempt: number, retryAfterMs?: number | null): number {
  if (retryAfterMs != null && retryAfterMs > 0) return retryAfterMs;
  return Math.min(2 ** (attempt - 1) * 500, 8000);
}

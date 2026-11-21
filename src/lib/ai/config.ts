import { AiConfigError } from "./errors";

/**
 * 服务端 AI 配置读取与校验（任务书 v3 §4.1）。
 * Key 只从服务端环境读取；所有错误与状态输出不包含 Key、完整 URL 或内部路径。
 * 数值一律检查上下界，非法值不允许变成无限循环/无限并发。
 */

export interface AiRateLimitConfig {
  enabled: boolean;
  tasksPerIpPerMinute: number;
  tasksPerIpPerDay: number;
  tasksPerUserPerDay: number;
}

export interface AiConfig {
  provider: "openai-compatible";
  /** 归一化后不带尾斜杠的接口地址；未配置为 null。 */
  baseUrl: string | null;
  apiKey: string | null;
  visionModel: string | null;
  /** 未配置时复用视觉模型（任务书 §4.1：必须写入配置说明，不猜测模型名）。 */
  textModel: string | null;
  imageMaxEdge: number;
  maxPhotosPerJob: number;
  maxConcurrency: number;
  requestTimeoutMs: number;
  maxRetries: number;
  maxOutputTokens: number;
  maxCallsPerJob: number;
  maxCallsPerDay: number;
  connectionTestLimitPerHour: number;
  dayTimezone: string;
  cacheEnabled: boolean;
  /** 字段齐全（不等于密钥有效或真实联调通过）。 */
  configured: boolean;
  /** 缺失的必填环境变量名（不含值）。 */
  missing: string[];
  /** 校验问题（中文，可展示给作者；不含密钥与 URL）。 */
  issues: string[];
  accessMode: "local" | "public";
  rateLimit: AiRateLimitConfig;
}

export const AI_ENV_DEFAULTS = {
  AI_IMAGE_MAX_EDGE: 1280,
  AI_MAX_PHOTOS_PER_JOB: 30,
  AI_MAX_CONCURRENCY: 2,
  AI_REQUEST_TIMEOUT_MS: 60_000,
  AI_MAX_RETRIES: 1,
  AI_MAX_OUTPUT_TOKENS: 2500,
  AI_MAX_CALLS_PER_JOB: 40,
  AI_MAX_CALLS_PER_DAY: 100,
  AI_CONNECTION_TEST_LIMIT_PER_HOUR: 5,
  AI_DAY_TIMEZONE: "Asia/Shanghai",
  AI_CACHE_ENABLED: true,
} as const;

const REQUIRED_KEYS = ["AI_API_KEY", "AI_BASE_URL", "AI_VISION_MODEL"] as const;

function boundedInt(
  env: NodeJS.ProcessEnv,
  name: string,
  min: number,
  max: number,
  dflt: number,
  issues: string[],
): number {
  const raw = env[name];
  if (raw == null || raw.trim() === "") return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    issues.push(`${name} 需为 ${min}–${max} 的整数（当前无效，已用默认值 ${dflt}）`);
    return dflt;
  }
  return n;
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

export function loadAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const issues: string[] = [];
  const apiKey = env.AI_API_KEY?.trim() || null;
  const baseUrlRaw = env.AI_BASE_URL?.trim() || null;
  const visionModel = env.AI_VISION_MODEL?.trim() || null;
  const textModel = env.AI_TEXT_MODEL?.trim() || null;
  const provider = env.AI_PROVIDER?.trim() || "openai-compatible";

  if (provider !== "openai-compatible") {
    issues.push("当前版本只支持 AI_PROVIDER=openai-compatible（OpenAI 兼容协议）");
  }

  let baseUrl: string | null = null;
  if (baseUrlRaw) {
    try {
      const u = new URL(baseUrlRaw);
      if (u.protocol !== "https:" && u.protocol !== "http:") {
        issues.push("AI_BASE_URL 必须是 http(s) 地址");
      } else if (u.protocol === "http:" && !isLoopback(u.hostname)) {
        issues.push("非本地模型服务必须使用 HTTPS；仅 localhost 允许 http");
      } else {
        // 固定拼接规则：去除尾斜杠，调用时统一追加 /chat/completions，避免重复 /v1 或接口路径。
        baseUrl = baseUrlRaw.replace(/\/+$/, "");
      }
    } catch {
      issues.push("AI_BASE_URL 不是合法地址");
    }
  } else {
    baseUrl = null;
  }

  let dayTimezone = (env.AI_DAY_TIMEZONE?.trim() || AI_ENV_DEFAULTS.AI_DAY_TIMEZONE) as string;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: dayTimezone }).format(new Date());
  } catch {
    issues.push(`AI_DAY_TIMEZONE 不是有效时区，已用默认值 ${AI_ENV_DEFAULTS.AI_DAY_TIMEZONE}`);
    dayTimezone = AI_ENV_DEFAULTS.AI_DAY_TIMEZONE as string;
  }

  const maxRetries = boundedInt(env, "AI_MAX_RETRIES", 0, 3, AI_ENV_DEFAULTS.AI_MAX_RETRIES, issues);
  const accessMode = env.AFTERLIGHT_ACCESS_MODE?.trim() === "public" ? "public" : "local";
  const rateLimitEnabled = (env.RATE_LIMIT_ENABLED?.trim() ?? "true") !== "false";
  const rateLimit: AiRateLimitConfig = {
    enabled: rateLimitEnabled,
    tasksPerIpPerMinute: boundedInt(env, "RATE_LIMIT_TASKS_PER_IP_PER_MINUTE", 1, 100, 2, issues),
    tasksPerIpPerDay: boundedInt(env, "RATE_LIMIT_TASKS_PER_IP_PER_DAY", 1, 1000, 5, issues),
    tasksPerUserPerDay: boundedInt(env, "RATE_LIMIT_TASKS_PER_USER_PER_DAY", 1, 1000, 5, issues),
  };
  if (accessMode === "public" && !rateLimitEnabled) {
    issues.push("AFTERLIGHT_ACCESS_MODE=public 要求 RATE_LIMIT_ENABLED=true（任务书 §9.2）");
  }

  const missing: string[] = [];
  for (const k of REQUIRED_KEYS) {
    if (!env[k]?.trim()) missing.push(k);
  }

  const config: AiConfig = {
    provider: "openai-compatible",
    baseUrl,
    apiKey,
    visionModel,
    textModel,
    imageMaxEdge: boundedInt(env, "AI_IMAGE_MAX_EDGE", 256, 8192, AI_ENV_DEFAULTS.AI_IMAGE_MAX_EDGE, issues),
    maxPhotosPerJob: boundedInt(env, "AI_MAX_PHOTOS_PER_JOB", 1, 60, AI_ENV_DEFAULTS.AI_MAX_PHOTOS_PER_JOB, issues),
    maxConcurrency: boundedInt(env, "AI_MAX_CONCURRENCY", 1, 8, AI_ENV_DEFAULTS.AI_MAX_CONCURRENCY, issues),
    requestTimeoutMs: boundedInt(env, "AI_REQUEST_TIMEOUT_MS", 1000, 300_000, AI_ENV_DEFAULTS.AI_REQUEST_TIMEOUT_MS, issues),
    maxRetries,
    maxOutputTokens: boundedInt(env, "AI_MAX_OUTPUT_TOKENS", 1, 8000, AI_ENV_DEFAULTS.AI_MAX_OUTPUT_TOKENS, issues),
    maxCallsPerJob: boundedInt(env, "AI_MAX_CALLS_PER_JOB", 1, 1000, AI_ENV_DEFAULTS.AI_MAX_CALLS_PER_JOB, issues),
    maxCallsPerDay: boundedInt(env, "AI_MAX_CALLS_PER_DAY", 1, 100_000, AI_ENV_DEFAULTS.AI_MAX_CALLS_PER_DAY, issues),
    connectionTestLimitPerHour: boundedInt(env, "AI_CONNECTION_TEST_LIMIT_PER_HOUR", 1, 60, AI_ENV_DEFAULTS.AI_CONNECTION_TEST_LIMIT_PER_HOUR, issues),
    dayTimezone,
    cacheEnabled: env.AI_CACHE_ENABLED?.trim() !== "false",
    configured: missing.length === 0,
    missing,
    issues,
    accessMode,
    rateLimit,
  };
  return config;
}

/** 外发前调用：未配置/无效时抛中文错误，不携带任何密钥。 */
export function assertUsable(config: AiConfig): void {
  if (!config.configured) {
    throw new AiConfigError(
      `AI 模型服务尚未配置：缺少 ${config.missing.join("、")}。请在服务端 .env.local 填写后重启（见 docs/ai-setup.md）；演示模式不受影响。`,
      { missing: config.missing },
    );
  }
  if (config.issues.length > 0) {
    throw new AiConfigError(`AI 配置无效：${config.issues.join("；")}`, { issues: config.issues });
  }
}

/** 固定路径拼接（任务书 §4.1）：baseUrl 已归一化，这里唯一追加接口路径。 */
export function chatCompletionsUrl(config: AiConfig): string {
  return `${config.baseUrl}/chat/completions`;
}

/** 选定的文本模型：AI_TEXT_MODEL 缺省时复用视觉模型（见 .env.example 说明）。 */
export function resolveTextModel(config: AiConfig): string {
  return config.textModel ?? config.visionModel!;
}

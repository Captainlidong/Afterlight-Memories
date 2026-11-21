import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { loadAiConfig, resolveTextModel, type AiConfig } from "./config";
import type { AiErrorClass } from "./errors";
import type { AiCallStatus } from "./records";

export const CONNECTION_PROBE_VERSION = "connection-smoke-v1";
export const CONNECTION_PROBE_AGENTS = { text: "connection_test_text", vision: "connection_test_vision" } as const;

export interface AiCapabilityStatus {
  state: "untested" | "running" | "succeeded" | "failed";
  at: string | null;
  message: string | null;
}

/** 展示契约不包含模型、地址、凭据、服务商原文或配置原始值。 */
export interface AiConnectionStatus {
  kind: "local_demo" | "not_configured" | "configured_untested" | "configured_with_issues" | "test_succeeded" | "connection_error";
  label: string;
  detail: string;
  missing: string[];
  issues: string[];
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestErrorClass: string | null;
  canTest: boolean;
  capabilities: { text: AiCapabilityStatus; vision: AiCapabilityStatus };
}

const ERROR_MESSAGES: Record<AiErrorClass, string> = {
  config: "AI 配置缺失或无效，请在服务端检查。",
  unauthorized: "当前访问方式不允许连接测试。",
  budget: "模型调用预算或连接测试频率已达上限，请稍后再试。",
  auth: "模型服务拒绝访问，请在服务端检查凭据和权限。",
  quota: "模型服务余额或配额不足，已停止后续测试。",
  transient: "模型服务暂时不可用或限流，本次未自动重试。",
  timeout: "模型服务响应超时，本次未自动重试。",
  invalid_response: "模型返回内容未通过本项能力测试。",
  provider: "连接测试未完成，请检查服务端配置后重试。",
  network: "无法连接模型服务，请检查网络后重试。",
  cancelled: "连接测试已取消，已发送请求可能仍计费。",
  queue: "连接测试排队已满或等待超时，本次排队未外发。",
  stale_context: "当前测试上下文已失效，请重新操作。",
  invalid_reference: "模型结果引用未通过校验。"
};

export function connectionErrorClass(value: unknown): AiErrorClass {
  return typeof value === "string" && Object.hasOwn(ERROR_MESSAGES, value) ? value as AiErrorClass : "provider";
}

export function connectionErrorMessage(value: unknown): string {
  return ERROR_MESSAGES[connectionErrorClass(value)];
}

export function canTestAiConnection(config: AiConfig): boolean {
  return config.accessMode === "local" && config.configured && config.issues.length === 0 &&
    config.missing.length === 0 && !!config.baseUrl && !!config.apiKey && !!config.visionModel;
}

/** 版本与配置绑定；schema_version 只保存摘要，绝不保存凭据或原始地址。 */
export function connectionSchemaVersion(config: AiConfig): string {
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  return `${CONNECTION_PROBE_VERSION}:${digest(JSON.stringify([
    config.provider, config.baseUrl, digest(config.apiKey ?? ""),
    config.textModel, resolveTextModel(config), config.visionModel, CONNECTION_PROBE_VERSION,
  ]))}`;
}

interface ProbeRow {
  status: AiCallStatus;
  created_at: string;
  finished_at: string | null;
  error_class: string | null;
}

function capability(row: ProbeRow | undefined, name: "text" | "vision"): AiCapabilityStatus {
  if (!row) return { state: "untested", at: null, message: null };
  const at = row.finished_at ?? row.created_at;
  if (row.status === "reserved" || row.status === "sent") {
    return { state: "running", at, message: "本项测试已开始，尚无完成结果。" };
  }
  if (row.status === "succeeded") {
    return { state: "succeeded", at, message: name === "text" ? "固定文字响应测试通过。" : "合成图片颜色测试通过；不代表真实照片语义理解已验证。" };
  }
  return { state: "failed", at, message: connectionErrorMessage(row.error_class) };
}

/** 精确 SQL 过滤后选最新点击；不截断全局最近 N 条，也不跨点击拼接成功。 */
function latestProbes(db: DatabaseSync, config: AiConfig) {
  const schemaVersion = connectionSchemaVersion(config);
  const scope = db.prepare(`SELECT scope_id FROM ai_calls
    WHERE scope_type=? AND purpose=? AND schema_version=? AND exhibition_id IS NULL AND agent_type IN (?,?)
    GROUP BY scope_id ORDER BY MIN(created_at) DESC, MIN(rowid) DESC LIMIT 1`).get(
    "connection_test", "connection_test", schemaVersion, CONNECTION_PROBE_AGENTS.text, CONNECTION_PROBE_AGENTS.vision,
  ) as { scope_id: string } | undefined;
  const read = (name: "text" | "vision") => scope ? db.prepare(`SELECT status, created_at, finished_at, error_class FROM ai_calls
    WHERE scope_type=? AND purpose=? AND schema_version=? AND exhibition_id IS NULL AND scope_id=? AND agent_type=?
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(
    "connection_test", "connection_test", schemaVersion, scope.scope_id, CONNECTION_PROBE_AGENTS[name],
  ) as ProbeRow | undefined : undefined;
  return { text: read("text"), vision: read("vision") };
}

export function getAiConnectionStatus(db: DatabaseSync, config: AiConfig): AiConnectionStatus {
  const base: AiConnectionStatus = {
    kind: "configured_untested", label: "已填写配置，尚未完成测试",
    detail: "字段完整不代表连接可用。文字与合成图片分别测试，外发计入预算。",
    missing: config.missing.filter((key) => ["AI_API_KEY", "AI_BASE_URL", "AI_VISION_MODEL"].includes(key)),
    // 配置校验文本可能包含无效时区等原始输入，不能直接展示。
    issues: config.issues.length ? ["AI 配置存在无效项，请在服务端检查后重试。"] : [],
    lastTestAt: null, lastTestOk: null, lastTestErrorClass: null,
    canTest: canTestAiConnection(config),
    capabilities: { text: capability(undefined, "text"), vision: capability(undefined, "vision") },
  };
  if (config.accessMode !== "local") {
    return { ...base, kind: "local_demo", label: "本地演示", detail: "公网访问不开放连接测试；请在本地服务端操作。" };
  }
  if (!config.configured) {
    return { ...base, kind: "not_configured", label: "AI 未配置", detail: "AI 必填配置尚未填写完整；本地演示仍可使用。" };
  }
  if (!base.canTest) {
    return { ...base, kind: "configured_with_issues", label: "已填写配置，但存在无效项", detail: "请在服务端检查 AI 配置；本地演示不受影响。" };
  }
  const rows = latestProbes(db, config);
  if (!rows.text && !rows.vision) return base;
  const capabilities = { text: capability(rows.text, "text"), vision: capability(rows.vision, "vision") };
  const states = Object.values(capabilities);
  const complete = states.every((item) => item.state === "succeeded");
  const running = states.some((item) => item.state === "running");
  const failed = states.some((item) => item.state === "failed");
  const failedRow = [rows.vision, rows.text].find((row) => row && !["succeeded", "reserved", "sent"].includes(row.status));
  return {
    ...base, capabilities,
    lastTestAt: states.map((item) => item.at).filter((at): at is string => at !== null).sort().at(-1) ?? null,
    lastTestOk: complete ? true : running && !failed ? null : false,
    lastTestErrorClass: failedRow ? connectionErrorClass(failedRow.error_class) : null,
    kind: complete ? "test_succeeded" : failed ? "connection_error" : "configured_untested",
    label: complete ? "最近一次连接测试成功" : failed ? "最近一次连接测试未通过" : "最近一次连接测试尚未完成",
    detail: complete ? "同一次测试的文字与合成图片检查均通过；仅为能力冒烟测试，不代表真实照片语义理解已验证。"
      : running ? "测试正在进行，请分别查看文字与图片状态。" : "文字与图片尚未同时通过；未执行的项目不视为成功。",
  };
}

export { loadAiConfig };

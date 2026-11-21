/**
 * 真实 AI 接入基础（任务书 v3 阶段 C）：配置、统一客户端、授权、预算、缓存、调用记录。
 * 仅服务端使用：不要从 React 组件或浏览器打包链导入（policy.assertServerSide 兜底）。
 */
export {
  AiConfigError,
  AiUnauthorizedError,
  AiBudgetError,
  AiProviderAuthError,
  AiProviderQuotaError,
  AiTransientError,
  AiTimeoutError,
  AiInvalidResponseError,
  AiProviderError,
  AiNetworkError,
  AiError,
  desensitize,
  parseRetryAfter,
  backoffMs,
  type AiErrorClass,
} from "./errors";

export {
  loadAiConfig,
  assertUsable,
  chatCompletionsUrl,
  resolveTextModel,
  type AiConfig,
  type AiRateLimitConfig,
} from "./config";

export { AiClient, classifyProviderError, type AiTransport, type AiRunOptions, type AiRunResult } from "./client";

export {
  assertExternalSendAllowed,
  assertServerSide,
  isUnauthorizedClass,
  type AiCallContext,
} from "./policy";

export {
  reserveAiCall,
  releaseAiReservation,
  releaseStaleAiReservations,
  getBudgetUsage,
  budgetPeriodsFor,
  dayKeyInTz,
  hourKeyInTz,
  type BudgetLimits,
} from "./budget";

export {
  cacheGet,
  cacheSave,
  cacheClearScope,
  buildCacheKey,
  canonicalDigest,
  type CacheLookupInput,
  type CacheSaveInput,
} from "./cache";

export {
  createAiCall,
  updateAiCall,
  getAiCall,
  listAiCalls,
  type AiCallRecord,
  type AiCallStatus,
  type AiScopeType,
  type AiPurpose,
  type NewAiCallInput,
  type AiCallUpdate,
} from "./records";

export { getAiConnectionStatus, type AiConnectionStatus } from "./status";

export {
  AI_PROMPT_VERSIONS,
  AI_SCHEMA_VERSIONS,
  visionPrompt,
  curationPrompt,
  motifPrompt,
  narrativePrompt,
  promptFor,
  type AiPromptRole,
} from "./prompts";

export {
  VisualFacts,
  VisualFactEvidence,
  type VisualFactsT,
  type AiUsage,
  type AiChatMessage,
  type AiUserContent,
  type AiImagePart,
  type AiTextPart,
} from "./schemas";

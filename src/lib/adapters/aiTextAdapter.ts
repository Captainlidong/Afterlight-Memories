import type { DatabaseSync } from "node:sqlite";
import { AiClient, type AiTransport } from "../ai/client";
import { canonicalDigest } from "../ai/cache";
import { assertUsable, loadAiConfig, resolveTextModel, type AiConfig } from "../ai/config";
import { AiBusinessValidationError, AiInvalidResponseError } from "../ai/errors";
import { AI_PROMPT_VERSIONS, AI_SCHEMA_VERSIONS, promptFor } from "../ai/prompts";
import { VisualFacts } from "../agents/schemas";
import { assertAiDataOnly } from "../ai/outputValidation";
import { isCredibleText } from "../agents/credibility";
import { ApiError } from "../api/errors";
import type { AdapterProvenance } from "./types";

type TextRole = "curation" | "motifs" | "narrative";
const agentTypes = { curation: "aesthetic_selector", motifs: "motif_finder", narrative: "narrative_editor" } as const;

export interface AiTextAdapterOptions {
  db: DatabaseSync;
  exhibitionId: string;
  workflowId: string;
  config?: AiConfig;
  transport?: AiTransport;
  signal?: AbortSignal;
  assertActive?: () => void;
  getCurrentConfig?: () => AiConfig;
}

export function assertVisualFacts(photos: { visual_facts?: unknown }[]): void {
  if (!photos.length || photos.some((p) => !VisualFacts.safeParse(p.visual_facts).success)) {
    throw new ApiError(409, "visual_facts_required", "部分照片缺少有效视觉事实，请先完成 AI 素材分析，再继续策展。");
  }
}

function assertAiTextCredibility(value: unknown): void {
  if (typeof value === "string" && !isCredibleText(value)) throw new AiBusinessValidationError();
  if (Array.isArray(value)) value.forEach(assertAiTextCredibility);
  else if (value && typeof value === "object") Object.values(value).forEach(assertAiTextCredibility);
}

export function assertDataOnly(value: unknown): void {
  assertAiDataOnly(value);
  assertAiTextCredibility(value);
}

export function createTextRunner(options: AiTextAdapterOptions, role: TextRole) {
  const getCurrentConfig = options.getCurrentConfig ?? (options.config ? () => options.config! : loadAiConfig);
  return async <T>(input: unknown, validate: (value: unknown) => T): Promise<{ data: T; provenance: AdapterProvenance }> => {
    const config = getCurrentConfig();
    assertUsable(config);
    const client = new AiClient(options.db, config, options.transport);
    const model = resolveTextModel(config);
    const digest = canonicalDigest(input);
    const result = await client.run({
      context: {
        purpose: role, scopeType: "workflow", scopeId: options.workflowId,
        exhibitionId: options.exhibitionId, workflowId: options.workflowId,
        agentType: agentTypes[role], promptVersion: AI_PROMPT_VERSIONS[role], schemaVersion: AI_SCHEMA_VERSIONS[role],
        assertActive: options.assertActive,
      },
      signal: options.signal,
      getCurrentConfig,
      model,
      messages: [{ role: "system", content: promptFor(role) }, { role: "user", content: JSON.stringify(input) }],
      maxTokens: config.maxOutputTokens,
      cacheKey: canonicalDigest({ digest, model, provider: config.provider, promptVersion: AI_PROMPT_VERSIONS[role], schemaVersion: AI_SCHEMA_VERSIONS[role], maxTokens: config.maxOutputTokens }),
      inputDigest: digest,
      parse(content) {
        // 真实联调诊断：业务/格式校验失败时把截断后的原始输出留在服务端日志，
        // 便于定位是回显、引用还是文案边界问题；不改变错误分类与重试行为。
        const diagnose = (err: unknown): never => {
          const sample = content.length > 2000 ? `${content.slice(0, 2000)}…(已截断)` : content;
          console.warn(
            `[afterlight][ai-diagnostics] role=${role} 输出校验失败: ${err instanceof Error ? err.message : String(err)}`,
            `\n[afterlight][ai-diagnostics] 原始输出样本: ${sample}`,
          );
          throw err;
        };
        let value: unknown;
        try { value = JSON.parse(content); }
        catch { return diagnose(new AiInvalidResponseError("策展模型返回的不是合法 JSON。")); }
        try { assertDataOnly(value); } catch (err) { diagnose(err); }
        try { return validate(value); } catch (err) { diagnose(err); }
        throw new AiInvalidResponseError("策展模型输出校验未通过。");
      },
    });
    return {
      data: result.data,
      provenance: {
        source: result.source === "cache" ? "ai_cache" : "ai",
        provider: config.provider, model, prompt_version: AI_PROMPT_VERSIONS[role],
        schema_version: AI_SCHEMA_VERSIONS[role], preprocess_version: "none",
        call_id: result.callId, cache_hit: result.source === "cache",
      },
    };
  };
}

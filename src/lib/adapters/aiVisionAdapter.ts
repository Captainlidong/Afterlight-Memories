import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { AiClient, type AiTransport } from "../ai/client";
import { buildCacheKey, canonicalDigest } from "../ai/cache";
import { assertUsable, loadAiConfig, type AiConfig } from "../ai/config";
import { AiInvalidResponseError } from "../ai/errors";
import { AI_PROMPT_VERSIONS, AI_SCHEMA_VERSIONS, visionPrompt } from "../ai/prompts";
import { AiVisualFacts, type VisualFactsT } from "../ai/schemas";
import { assertAiDataOnly } from "../ai/outputValidation";
import type { AdapterResult, VisionAdapter, VisionDescription, VisionInput } from "./types";

export interface AiVisionAdapterOptions {
  db: DatabaseSync;
  config?: AiConfig;
  transport?: AiTransport;
  signal?: AbortSignal;
  assertActive?: (input: VisionInput) => void;
  getCurrentConfig?: () => AiConfig;
}

export interface AiVisionAdapter extends VisionAdapter {
  describePhoto(input: VisionInput): Promise<AdapterResult<VisionDescription>>;
}

function parseVisualFacts(content: string): VisualFactsT {
  try {
    const value: unknown = JSON.parse(content);
    assertAiDataOnly(value);
    return AiVisualFacts.parse(value);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new AiInvalidResponseError("视觉模型返回的事实不是合法 JSON。");
    }
    throw err;
  }
}

export function createAiVisionAdapter(options: AiVisionAdapterOptions): AiVisionAdapter {
  // 显式注入配置的测试不读取真实环境；生产每次调用及获槽时重读当前配置。
  const getCurrentConfig = options.getCurrentConfig ?? (options.config ? () => options.config! : loadAiConfig);

  return {
    async describePhoto(input: VisionInput): Promise<AdapterResult<VisionDescription>> {
      if (!input.image) throw new Error("AI 视觉分析缺少服务端压缩图片。");
      input = { ...input, metrics: structuredClone(input.metrics), image: { ...input.image, bytes: Buffer.from(input.image.bytes) } };
      const config = getCurrentConfig();
      assertUsable(config);
      const client = new AiClient(options.db, config, options.transport);
      const image = input.image!;
      const analysisHash = createHash("sha256").update(image.bytes).digest("hex");
      const imageUrl = `data:${image.mimeType};base64,${image.bytes.toString("base64")}`;
      const result = await client.run({
        signal: options.signal,
        getCurrentConfig,
        context: {
          purpose: "vision",
          scopeType: "workflow",
          scopeId: input.workflowId,
          exhibitionId: input.exhibitionId,
          agentType: "material_steward",
          workflowId: input.workflowId,
          promptVersion: AI_PROMPT_VERSIONS.vision,
          schemaVersion: AI_SCHEMA_VERSIONS.vision,
          preprocessVersion: image.preprocessVersion,
          photoId: input.photoId,
          photoSha256: input.sha256,
          assertActive: () => options.assertActive?.(input),
        },
        model: config.visionModel!,
        messages: [
          { role: "system", content: visionPrompt() },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `观察这张照片并返回视觉事实。本地技术指标仅供参考，不是画面语义：${JSON.stringify(input.metrics)}`,
              },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ],
        maxTokens: 2500,
        parse: parseVisualFacts,
        cacheKey: buildCacheKey({
          analysisImageSha256: analysisHash,
          metrics: input.metrics,
        }),
        inputDigest: canonicalDigest({
          analysisImageSha256: analysisHash,
          metrics: input.metrics,
        }),
      });
      return {
        subjects: result.data.subjects,
        composition_tags: result.data.composition_tags,
        visual_embedding: null,
        processing_mode: "ai",
        visual_facts: result.data,
        visual_source: result.source,
        source_call_id: result.callId,
        analysis_image_sha256: analysisHash,
        provenance: {
          source: result.source === "cache" ? "ai_cache" : "ai",
          call_id: result.callId,
          cache_hit: result.source === "cache",
          provider: config.provider,
          model: config.visionModel!,
          prompt_version: AI_PROMPT_VERSIONS.vision,
          schema_version: AI_SCHEMA_VERSIONS.vision,
          preprocess_version: image.preprocessVersion,
        },
      };
    },
  };
}

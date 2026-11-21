import { z } from "zod";
import { CurationResult, MotifResult, NarrativePlan, VisualFactEvidence, VisualFacts } from "../agents/schemas";

/**
 * 模型响应结构（任务书 v3 §5.2 / §6）。
 * 视觉事实为增量扩展的最小结构：观察与解读分开，不识别身份、不推断私密属性；
 * 选片/主题/叙事直接复用 agents/schemas 的既有契约（§6.4：先 Zod 结构校验）。
 */

export type VisualFactsT = z.infer<typeof VisualFacts>;

/** Stricter model boundary; stored legacy facts and user-facing contracts stay compatible. */
export const AiVisualFacts = VisualFacts.extend({
  summary: z.string().trim().min(1).max(100),
  subjects: z.array(z.string().trim().min(1).max(30)).min(1).max(8),
  composition_tags: z.array(z.string().trim().min(1).max(30)).max(6),
  light_tags: z.array(z.string().trim().min(1).max(30)).max(6),
  spatial_relations: z.array(z.string().trim().min(1).max(50)).max(6),
  evidence: z.array(VisualFactEvidence.extend({ text: z.string().trim().min(1).max(100) }).strict()).max(6),
  uncertainties: z.array(z.string().trim().min(1).max(100)).max(4),
}).strict();

/** 服务商返回的 usage；缺字段记 null（未知 ≠ 0，任务书 §7.1）。 */
export interface AiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** 统一消息结构：文本 + 可选图片（data URL，仅服务端组装，不进前端状态）。 */
export type AiImagePart = { type: "image_url"; image_url: { url: string } };
export type AiTextPart = { type: "text"; text: string };
export type AiUserContent = string | Array<AiTextPart | AiImagePart>;
export type AiChatMessage =
  | { role: "system" | "assistant"; content: string }
  | { role: "user"; content: AiUserContent };

export { CurationResult, MotifResult, NarrativePlan, VisualFactEvidence, VisualFacts };

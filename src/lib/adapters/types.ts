import type { RunMode } from "../mode";
import type { AestheticPrefsT, CurationResultT, MotifResultT, NarrativePlanT, ToneT, VisualFactsT } from "../agents/schemas";
import type { PreparedVisionImage } from "../image/prepareForAi";

/**
 * 适配层契约（设计文档 §9.3）。模型调用一律经此层，绝不把 SDK 写死在组件内。
 * VisionAdapter 供素材管家（语义标签）；CurationAdapter 供审美筛选官。
 */

export interface VisionMetrics {
  sharpness_score: number;
  brightness_score: number;
  highlight_clip_ratio: number;
  shadow_clip_ratio: number;
  color_temp: number;
  saturation: number;
  dominant_colors: string[];
}

export interface VisionInput {
  photoId: string;
  exhibitionId: string;
  workflowId: string;
  sha256: string;
  metrics: VisionMetrics;
  image?: PreparedVisionImage;
}

export interface VisionDescription {
  subjects: string[];
  composition_tags: string[];
  visual_embedding: number[] | null;
  processing_mode: "demo" | "heuristic" | "ai";
  visual_facts?: VisualFactsT | null;
  visual_source?: "fresh" | "cache" | null;
  source_call_id?: string | null;
  analysis_image_sha256?: string | null;
}

export interface VisionAdapter {
  describePhoto(input: VisionInput): Promise<VisionDescription>;
}

/** 审美筛选输入：每张照片的可观察指标 + 重复关系 + 语义标签（§6.3）。 */
export interface CurationPhotoInput {
  photoId: string;
  sha256: string;
  sharpness_score: number;
  brightness_score: number;
  highlight_clip_ratio: number;
  shadow_clip_ratio: number;
  color_temp: number | null;
  saturation: number | null;
  subjects: string[];
  composition_tags: string[];
  visual_facts?: VisualFactsT | null;
  duplicate_group_id: string | null;
}

export interface CurationInput {
  photos: CurationPhotoInput[];
  prefs: AestheticPrefsT;
}

export interface AdapterProvenance {
  source: "ai" | "ai_cache" | "demo_preset" | "heuristic" | "mixed";
  provider?: string;
  model?: string;
  prompt_version?: string;
  schema_version?: string;
  preprocess_version?: string;
  call_id?: string | null;
  cache_hit?: boolean;
}

export type AdapterResult<T> = T & { provenance?: AdapterProvenance };

export interface CurationAdapter {
  curate(input: CurationInput): Promise<AdapterResult<CurationResultT>>;
}

/** 主题发现输入：仅保留照片（keep + must_keep）的可观察语义 + 色彩/构图线索（§6.4）。 */
export interface MotifPhotoInput {
  photoId: string;
  sha256: string;
  subjects: string[];
  composition_tags: string[];
  visual_facts?: VisualFactsT | null;
  color_temp: number | null;
  saturation: number | null;
  brightness_score: number;
  duplicate_group_id: string | null;
}

export interface MotifInput {
  photos: MotifPhotoInput[];
  prefs: AestheticPrefsT;
  userIntent?: string | null;
}

export interface MotifAdapter {
  discover(input: MotifInput): Promise<AdapterResult<MotifResultT>>;
}

/** 叙事输入：所选主题 + 保留照片（keep + must_keep）的可观察语义/指标 + 语气（§6.5 / 提示词5）。 */
export interface NarrativePhotoInput {
  photoId: string;
  sha256: string;
  subjects: string[];
  composition_tags: string[];
  visual_facts?: VisualFactsT | null;
  color_temp: number | null;
  saturation: number | null;
  brightness_score: number;
  sharpness_score: number;
  duplicate_group_id: string | null;
  sort_order: number;
}

export interface NarrativeMotifInput {
  motifId: string;
  title: string;
  description: string;
  photo_ids: string[];
  evidence: string[];
}

export interface NarrativeInput {
  motif: NarrativeMotifInput;
  photos: NarrativePhotoInput[];
  mustKeepIds: string[];
  tone: ToneT;
  chapterCount?: number;
  userIntent?: string | null;
  exhibitionTitle?: string | null;
  regenerationScope?: "preserve" | "unlocked" | "all";
  requiredChapterIds?: string[];
}

export interface NarrativeAdapter {
  compose(input: NarrativeInput): Promise<AdapterResult<NarrativePlanT>>;
}

export type { RunMode };
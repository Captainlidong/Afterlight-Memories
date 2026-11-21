import { z } from "zod";

/**
 * 所有契约的唯一事实源（设计文档 §6 / §10 / §11）。
 * TS 类型一律 z.infer；demo 预设 JSON 与测试都对此校验。
 */

// ---------- 枚举 ----------
export const SourceType = z.enum(["travel", "campus", "daily", "phase", "other"]);
export const Tone = z.enum(["documentary", "restrained", "poetic", "direct"]);
export const AiDecision = z.enum(["keep", "hold", "remove"]);
export const UserDecision = z.enum(["keep", "hold", "remove", "must_keep"]);
export const Template = z.enum(["cinema_scroll", "archive_collage"]);
export const Severity = z.enum(["low", "medium", "high"]);
export const AgentType = z.enum([
  "material_steward",
  "aesthetic_selector",
  "motif_finder",
  "narrative_editor",
  "exhibition_designer",
  "curatorial_qa",
]);
export const RunStatus = z.enum(["pending", "running", "completed", "failed", "skipped"]);
export const ExhibitionStatus = z.enum([
  "draft",
  "uploading",
  "ingesting",
  "selecting",
  "awaiting_selection_confirm",
  "motifs_ready",
  "awaiting_theme_choice",
  "writing",
  "designing",
  "checking",
  "awaiting_user_review",
  "published",
  "stage_failed",
]);

/** 文案约束：每段 ≤100 中文字符（提示词5）。 */
const shortText = z.string().max(100);
const titleText = z.string().max(60);
const score = z.number().min(0).max(1);

// ---------- 审美偏好 ----------
export const AestheticPrefs = z.object({
  repetition: z.enum(["fewer", "more"]).default("fewer"),
  focus: z.array(z.enum(["people", "architecture", "light", "color", "space"])).default([]),
});

// ---------- 创建影展（§11.1） ----------
export const CreateExhibitionInput = z.object({
  title: z.string().max(60).optional().default(""),
  source_type: SourceType.optional(),
  user_intent: z.string().max(500).optional(),
  tone: Tone.optional().default("restrained"),
  aesthetic_prefs: AestheticPrefs.optional(),
  allow_exif: z.boolean().optional().default(true),
  allow_external_ai: z.boolean().optional().default(false),
  privacy_mode: z.enum(["local_first", "external"]).optional().default("local_first"),
  mode: z.enum(["demo", "ai"]).optional(),
});

// ---------- 素材技术分析（§10.3） ----------
export const VisualFactEvidence = z.object({
  kind: z.enum(["observation", "interpretation"]),
  text: z.string().min(1).max(100),
});

export const VisualFacts = z.object({
  summary: z.string().min(1).max(100),
  subjects: z.array(z.string().min(1).max(30)).min(1).max(8),
  composition_tags: z.array(z.string().min(1).max(30)).max(6),
  light_tags: z.array(z.string().min(1).max(30)).max(6),
  spatial_relations: z.array(z.string().min(1).max(50)).max(6),
  evidence: z.array(VisualFactEvidence).max(6),
  uncertainties: z.array(z.string().min(1).max(100)).max(4),
});

export const PhotoInspection = z.object({
  photo_id: z.string(),
  sharpness_score: score,
  laplacian_var: z.number().min(0),
  brightness_score: score,
  highlight_clip_ratio: z.number().min(0).max(1),
  shadow_clip_ratio: z.number().min(0).max(1),
  dominant_colors: z.array(z.string()),
  color_temp: z.number().min(-1).max(1).nullable().optional(),
  saturation: z.number().min(0).max(1).nullable().optional(),
  subjects: z.array(z.string()).default([]),
  composition_tags: z.array(z.string()).default([]),
  visual_embedding: z.array(z.number()).nullable().optional(),
  visual_facts: VisualFacts.nullable().optional().default(null),
  visual_source: z.enum(["fresh", "cache"]).nullable().optional().default(null),
  analysis_image_sha256: z.string().length(64).nullable().optional().default(null),
  duplicate_group_id: z.string().nullable().optional(),
  processing_mode: z.enum(["demo", "heuristic", "ai"]),
});

// ---------- 审美筛选决定（§6.3 / §10.4） ----------
export const CurationDecision = z.object({
  photo_id: z.string(),
  decision: AiDecision,
  score,
  confidence: score,
  reasons: z.array(z.string()).min(1),
  related_photo_ids: z.array(z.string()).default([]),
  user_override_allowed: z.boolean().default(true),
});
export const CurationResult = z.object({ decisions: z.array(CurationDecision) });

// ---------- 主题（§6.4 / §10.5） ----------
export const Motif = z.object({
  id: z.string().optional(),
  title: titleText,
  description: shortText,
  photo_ids: z.array(z.string()).min(1),
  evidence: z.array(z.string()).min(1),
  confidence: score,
  alternative_readings: z.array(z.string()).default([]),
});
export const MotifResult = z.object({ motifs: z.array(Motif).max(4) });

// ---------- 叙事（§6.5 / §10.6） ----------
export const PlacementReason = z.object({
  photo_id: z.string(),
  role: z.enum(["opening", "development", "turning", "closing"]),
  reason: shortText,
});
export const Chapter = z.object({
  id: z.string(),
  title: titleText,
  description: shortText,
  photo_ids: z.array(z.string()).min(1),
  opening_photo_id: z.string().optional(),
  closing_photo_id: z.string().optional(),
  placement_reasons: z.array(PlacementReason).default([]),
  locked: z.boolean().default(false),
});
export const NarrativePlan = z.object({
  selected_motif_id: z.string().optional(),
  title: titleText,
  subtitle: z.string().max(80).optional().default(""),
  curatorial_statement: shortText,
  chapters: z.array(Chapter).min(2).max(4),
  tone: Tone,
});

// ---------- 布局（§6.6 / §10.7） ----------
const sectionBase = { id: z.string() };
export const LayoutSection = z.discriminatedUnion("type", [
  z.object({ ...sectionBase, type: z.literal("hero"), photo_id: z.string(), height: z.string().default("92vh"), caption_position: z.string().default("bottom-left") }),
  z.object({ ...sectionBase, type: z.literal("chapter_intro"), chapter_id: z.string(), spacing: z.enum(["small", "medium", "large"]).default("large") }),
  z.object({ ...sectionBase, type: z.literal("single_image"), photo_id: z.string(), size: z.enum(["medium", "large", "full"]).default("large"), spacing: z.enum(["small", "medium", "large"]).default("medium") }),
  z.object({ ...sectionBase, type: z.literal("image_pair"), photo_ids: z.array(z.string()).length(2), ratio: z.string().default("60-40"), gap: z.enum(["small", "medium", "large"]).default("medium") }),
  z.object({ ...sectionBase, type: z.literal("image_group"), photo_ids: z.array(z.string()).min(2).max(4), gap: z.enum(["small", "medium", "large"]).default("small") }),
  z.object({ ...sectionBase, type: z.literal("spacer"), size: z.enum(["small", "medium", "large"]).default("large") }),
  z.object({ ...sectionBase, type: z.literal("statement"), chapter_id: z.string().optional(), text_override: z.string().max(100).optional() }),
  z.object({ ...sectionBase, type: z.literal("ending"), photo_ids: z.array(z.string()).min(1).max(2) }),
]);
export const ExhibitionLayout = z.object({
  template: Template,
  background: z.string(),
  text_color: z.string(),
  sections: z.array(LayoutSection).min(1),
});

// ---------- 质检（§6.7） ----------
export const QaIssue = z.object({
  id: z.string(),
  severity: Severity,
  type: z.enum([
    "repetition",
    "similar_run",
    "chapter_rhythm",
    "credibility",
    "must_keep_missing",
    "mobile_overflow",
    "duplicate_title",
    "abrupt_ending",
    "broken_file",
    "privacy_hint",
  ]),
  message: z.string(),
  photo_ids: z.array(z.string()).default([]),
  chapter_id: z.string().optional(),
  auto_fix_available: z.boolean().default(false),
});
export const QaReport = z.object({
  status: z.enum(["passed", "needs_review"]),
  issues: z.array(QaIssue),
  passed_checks: z.array(z.string()),
});

// ---------- 质检忽略（§6.7） ----------
export const IgnoreIssueInput = z.object({
  ignored: z.boolean().optional().default(true),
});

// ---------- 导出（§导出） ----------
export const ExportInput = z.object({
  format: z.enum(["html", "json"]).optional().default("html"),
});

// ---------- 叙事更新（§11.9） ----------
export const NarrativeEdit = z.object({
  target_path: z.string(),
  value: z.unknown(),
  locked: z.boolean().optional(),
});
export const UpdateNarrativeInput = z.object({
  edits: z.array(NarrativeEdit).min(1),
  /** 必填双 CAS：生成版本和编辑修订任一个不匹配都拒绝旧草稿。 */
  expected_version: z.number().int().min(0),
  expected_edit_revision: z.number().int().min(0),
});
export const RegenerateNarrativeInput = z.object({
  scope: z.enum(["unlocked", "all"]).default("unlocked"),
  tone: Tone.optional(),
  request_id: z.string().min(1).max(64).optional(),
});

/** 叙事重跑（preserve 意图保留全部用户编辑）；可选 tone 仅在成功发布时写入。 */
export const RunNarrativeInput = z.object({
  tone: Tone.optional(),
  request_id: z.string().min(1).max(64).optional(),
});

// ---------- run 触发幂等键（任务书 v2.1 §19.2.9） ----------
export const RunTriggerInput = z.object({
  request_id: z.string().min(1).max(64).optional(),
});

// ---------- 照片决定覆盖（§11.5） ----------
export const UpdateDecisionInput = z.object({
  decision: UserDecision,
  reason: z.string().max(300).optional(),
  include_motifs: z.boolean().optional().default(false),
});

// ---------- 确认选片（任务书 v2.1 §19.3 / §19.11） ----------
export const HoldPolicy = z.enum(["exclude", "include"]);
export const ConfirmSelectionInput = z.object({
  expected_revision: z.number().int().min(0),
  hold_policy: HoldPolicy.default("exclude"),
  discover_motifs: z.boolean().default(true),
  request_id: z.string().min(1).max(64).optional(),
});

// ---------- 批量策展（任务书 v2.1 §19.5） ----------
export const BatchCurationInput = z
  .object({
    photo_ids: z.array(z.string().min(1)).min(1).max(60),
    action: z.enum(["set_decision", "restore_ai_suggestion"]),
    decision: UserDecision.optional(),
    include_must_keep: z.boolean().default(false),
    expected_revision: z.number().int().min(0),
    request_id: z.string().min(1).max(64).optional(),
  })
  .refine((v) => v.action !== "set_decision" || v.decision != null, {
    message: "set_decision 必须提供 decision。",
    path: ["decision"],
  });

// ---------- 选择主题（§11.7） ----------
export const SelectMotifInput = z.object({
  motif_id: z.string(),
  custom_title: z.string().max(60).optional(),
});

// ---------- 主题改名 / 拒绝（§8.7） ----------
export const UpdateMotifInput = z.object({
  title: z.string().max(60).optional(),
  state: z.enum(["proposed", "rejected"]).optional(),
});

// ---------- 类型导出 ----------
export type SourceTypeT = z.infer<typeof SourceType>;
export type ToneT = z.infer<typeof Tone>;
export type AiDecisionT = z.infer<typeof AiDecision>;
export type UserDecisionT = z.infer<typeof UserDecision>;
export type TemplateT = z.infer<typeof Template>;
export type AgentTypeT = z.infer<typeof AgentType>;
export type RunStatusT = z.infer<typeof RunStatus>;
export type ExhibitionStatusT = z.infer<typeof ExhibitionStatus>;
export type AestheticPrefsT = z.infer<typeof AestheticPrefs>;
export type CreateExhibitionInputT = z.infer<typeof CreateExhibitionInput>;
export type VisualFactEvidenceT = z.infer<typeof VisualFactEvidence>;
export type VisualFactsT = z.infer<typeof VisualFacts>;
export type PhotoInspectionT = z.infer<typeof PhotoInspection>;
export type CurationDecisionT = z.infer<typeof CurationDecision>;
export type CurationResultT = z.infer<typeof CurationResult>;
export type MotifT = z.infer<typeof Motif>;
export type MotifResultT = z.infer<typeof MotifResult>;
export type ChapterT = z.infer<typeof Chapter>;
export type PlacementReasonT = z.infer<typeof PlacementReason>;
export type NarrativePlanT = z.infer<typeof NarrativePlan>;
export type NarrativeEditT = z.infer<typeof NarrativeEdit>;
export type UpdateNarrativeInputT = z.infer<typeof UpdateNarrativeInput>;
export type RegenerateNarrativeInputT = z.infer<typeof RegenerateNarrativeInput>;
export type RunNarrativeInputT = z.infer<typeof RunNarrativeInput>;
export type HoldPolicyT = z.infer<typeof HoldPolicy>;
export type ConfirmSelectionInputT = z.infer<typeof ConfirmSelectionInput>;
export type BatchCurationInputT = z.infer<typeof BatchCurationInput>;
export type LayoutSectionT = z.infer<typeof LayoutSection>;
export type ExhibitionLayoutT = z.infer<typeof ExhibitionLayout>;
export type QaIssueT = z.infer<typeof QaIssue>;
export type QaReportT = z.infer<typeof QaReport>;
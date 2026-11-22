import type {
  AestheticPrefsT,
  AgentTypeT,
  AiDecisionT,
  ChapterT,
  ExhibitionStatusT,
  LayoutSectionT,
  QaIssueT,
  RunStatusT,
  SourceTypeT,
  TemplateT,
  ToneT,
  UserDecisionT,
} from "@/lib/agents/schemas";
import type { RunMode } from "@/lib/mode";
import type { ExifSummary } from "@/lib/image/exif";
import type { Stage } from "@/lib/orchestrator/stateMachine";

export type {
  SourceTypeT,
  ToneT,
  AiDecisionT,
  UserDecisionT,
  TemplateT,
  AgentTypeT,
  RunStatusT,
  ExhibitionStatusT,
  AestheticPrefsT,
  CreateExhibitionInputT,
  PhotoInspectionT,
  CurationDecisionT,
  MotifT,
  ChapterT,
  NarrativePlanT,
  LayoutSectionT,
  ExhibitionLayoutT,
  QaIssueT,
  QaReportT,
} from "@/lib/agents/schemas";

export type { RunMode } from "@/lib/mode";

/** 影展 DTO（DB 行映射，JSON 列已解析）。 */
export interface Exhibition {
  id: string;
  title: string;
  subtitle: string;
  source_type: SourceTypeT | null;
  user_intent: string | null;
  tone: ToneT;
  aesthetic_prefs: AestheticPrefsT;
  allow_exif: boolean;
  allow_external_ai: boolean;
  privacy_mode: string;
  mode: RunMode;
  is_demo_set: boolean;
  status: ExhibitionStatusT;
  failed_stage: Stage | null;
  stale_from: Stage | null;
  selected_motif_id: string | null;
  template: TemplateT;
  current_version: number;
  input_revision: number;
  selection_confirmed_revision: number | null;
  selection_confirmed_photo_ids: string[] | null;
  selection_hold_policy: "exclude" | "include" | null;
  created_at: string;
  updated_at: string;
  /** 公网匿名会话归属；本机版恒为 null */
  session_id: string | null;
}

/** 照片资产 DTO（DB 行映射，exif_json 已解析）。 */
export interface PhotoAsset {
  id: string;
  exhibition_id: string;
  original_name: string;
  storage_path: string;
  thumbnail_path: string | null;
  width: number | null;
  height: number | null;
  mime_type: string;
  file_size: number;
  sha256: string;
  phash: string | null;
  exif: ExifSummary | null;
  has_exif: boolean;
  privacy_status: string;
  status: string;
  error_message: string | null;
  sort_order: number;
  created_at: string;
}

/** Agent 运行 DTO（input/output JSON 已解析）。 */
export interface AgentRun {
  id: string;
  exhibition_id: string;
  agent_type: AgentTypeT;
  status: RunStatusT;
  input_version: number;
  workflow_id: string | null;
  input_revision: number | null;
  input_json: unknown;
  output_json: unknown;
  error_message: string | null;
  duration_ms: number | null;
  created_at: string;
  finished_at: string | null;
}

/**
 * 审美筛选决定 DTO（§10.4）。ai_decision 与 user_override 列分离：
 * Agent 只写 ai_*；must_keep 只能由用户写入。读取一律用 effective_decision。
 */
export interface CurationDecisionDTO {
  photo_id: string;
  exhibition_id: string;
  ai_decision: AiDecisionT;
  score: number;
  confidence: number;
  reasons: string[];
  related_photo_ids: string[];
  user_override: UserDecisionT | null;
  override_reason: string | null;
  effective_decision: UserDecisionT;
  run_id: string | null;
  updated_at: string;
}

/** 主题 DTO（§10.5）。effective_title = user_title ?? title；state 记录选择/拒绝。 */
export interface MotifDTO {
  id: string;
  exhibition_id: string;
  title: string;
  user_title: string | null;
  effective_title: string;
  description: string;
  photo_ids: string[];
  evidence: string[];
  confidence: number;
  alternative_readings: string[];
  state: "proposed" | "selected" | "rejected";
  run_id: string | null;
  created_at: string;
}

/** narrative_plans 当前行（chapters 已解析；前端/merge/版本快照共用）。 */
export interface NarrativeDTO {
  /** 与叙事一并读取的生成版本；PATCH expected_version 使用此值，不使用异步 status。 */
  current_version: number;
  /** 每次保存/生成/恢复都递增，历史快照不能复位。 */
  edit_revision: number;
  exhibition_id: string;
  selected_motif_id: string | null;
  title: string;
  subtitle: string;
  curatorial_statement: string;
  chapters: ChapterT[];
  tone: ToneT;
  source: string;
  input_version: number;
  run_id: string | null;
  updated_at: string;
}

/** 布局 DTO（DB 行映射，sections JSON 已解析）。 */
export interface LayoutDTO {
  exhibition_id: string;
  template: TemplateT;
  background: string;
  text_color: string;
  sections: LayoutSectionT[];
  input_version: number;
  run_id: string | null;
  updated_at: string;
}

/** 质检 DTO（issues 为未被忽略的活跃问题；ignored_keys 跨重跑保留）。 */
export interface QaDTO {
  exhibition_id: string;
  status: "passed" | "needs_review";
  issues: QaIssueT[];
  ignored_issues: QaIssueT[];
  ignored_keys: string[];
  passed_checks: string[];
  run_id: string | null;
  updated_at: string;
}

/** user_edits 覆盖层一行（value 已解析；locked 由系统/用户共同保护）。 */
export interface UserEditDTO {
  id: string;
  exhibition_id: string;
  target_path: string;
  value: unknown;
  locked: boolean;
  created_at: string;
  updated_at: string;
}

/** 版本摘要（列表用，不含快照本体）。 */
export interface VersionSummary {
  id: string;
  exhibition_id: string;
  version: number;
  label: string | null;
  created_at: string;
}

/** 完整版本（含快照，回滚用）。 */
export interface VersionDTO extends VersionSummary {
  snapshot: unknown;
}
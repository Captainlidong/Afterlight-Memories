import type { AgentTypeT, ExhibitionStatusT } from "../agents/schemas";

/**
 * 策展阶段图（设计文档 §5.1 / §7.2 + 任务书 v2.1 §19.1）。
 * ingest → select → [GATE 确认选片] → motifs → [GATE 选主题] → narrative → layout → qa
 * 每阶段有 running/done 两个状态；done 即" resting / 等待下一步"。
 */
export const STAGES = ["ingest", "select", "motifs", "narrative", "layout", "qa"] as const;
export type Stage = (typeof STAGES)[number];

export interface StageMeta {
  agent: AgentTypeT;
  running: ExhibitionStatusT;
  done: ExhibitionStatusT;
  label: string;
  /** 面向普通用户的说法（§19.6），技术 label 仅用于处理详情。 */
  userLabel: string;
}

export const STAGE_META: Record<Stage, StageMeta> = {
  ingest: { agent: "material_steward", running: "ingesting", done: "selecting", label: "素材读取", userLabel: "读取照片" },
  select: { agent: "aesthetic_selector", running: "selecting", done: "awaiting_selection_confirm", label: "审美筛选", userLabel: "推荐选片" },
  motifs: { agent: "motif_finder", running: "motifs_ready", done: "awaiting_theme_choice", label: "主题发现", userLabel: "发现主题" },
  narrative: { agent: "narrative_editor", running: "writing", done: "designing", label: "叙事生成", userLabel: "编写叙事" },
  layout: { agent: "exhibition_designer", running: "designing", done: "checking", label: "布局设计", userLabel: "设计版式" },
  qa: { agent: "curatorial_qa", running: "checking", done: "awaiting_user_review", label: "策展质检", userLabel: "检查影展" },
};

export function isStage(s: string): s is Stage {
  return (STAGES as readonly string[]).includes(s);
}

export function stageIndex(s: Stage): number {
  return STAGES.indexOf(s);
}

/** 闭区间 [from, to] 的阶段序列；非法范围返回空。 */
export function stagesBetween(from: Stage, to: Stage): Stage[] {
  const i = stageIndex(from);
  const j = stageIndex(to);
  if (i < 0 || j < 0 || j < i) return [];
  return STAGES.slice(i, j + 1);
}

/** 叙事阶段的门：必须已选主题（§5.1 GATE）。 */
export const GATE_BEFORE_NARRATIVE = "awaiting_theme_choice";

/** 主题发现阶段的门：必须已确认选片（任务书 v2.1 §19.1 / §19.3）。 */
export const GATE_BEFORE_MOTIFS = "awaiting_selection_confirm";
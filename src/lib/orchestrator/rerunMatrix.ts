import type { DatabaseSync } from "node:sqlite";
import { getExhibition, updateExhibition, clearConfirmation } from "../db/repos";
import { stageIndex, type Stage } from "./stateMachine";

/**
 * 局部重跑矩阵（设计文档 §7.3 / 计划重跑表）。数据驱动：编辑后只设 stale_from，不自动重跑，
 * 由"应用修改并重新生成"按钮触发。改文案/改主题名/锁定不重跑（布局实时读叙事）。
 * ceiling = 当前已实现的最高阶段；clampRange 把理想范围截断到可执行范围。
 */
export type RerunAction =
  | "delete_photo"
  | "must_keep"
  | "must_keep_with_motifs"
  | "override_decision"
  | "select_theme"
  | "change_tone"
  | "change_template"
  | "reorder_chapters"
  | "reorder_photos"
  | "edit_text"
  | "rename_motif"
  | "lock_field";

export interface RerunRule {
  rerun: boolean;
  from: Stage;
  to: Stage;
  stale_from: Stage | null;
}

export const RERUN_MATRIX: Record<RerunAction, RerunRule> = {
  delete_photo: { rerun: true, from: "motifs", to: "qa", stale_from: "motifs" },
  must_keep: { rerun: true, from: "narrative", to: "qa", stale_from: "narrative" },
  must_keep_with_motifs: { rerun: true, from: "motifs", to: "qa", stale_from: "motifs" },
  override_decision: { rerun: true, from: "narrative", to: "qa", stale_from: "narrative" },
  select_theme: { rerun: true, from: "narrative", to: "qa", stale_from: "narrative" },
  change_tone: { rerun: true, from: "narrative", to: "qa", stale_from: "narrative" },
  change_template: { rerun: true, from: "layout", to: "qa", stale_from: "layout" },
  reorder_chapters: { rerun: true, from: "layout", to: "qa", stale_from: "layout" },
  reorder_photos: { rerun: true, from: "layout", to: "qa", stale_from: "layout" },
  edit_text: { rerun: false, from: "narrative", to: "narrative", stale_from: null },
  rename_motif: { rerun: false, from: "motifs", to: "motifs", stale_from: null },
  lock_field: { rerun: false, from: "narrative", to: "narrative", stale_from: null },
};

export function rerunRule(action: RerunAction): RerunRule {
  return RERUN_MATRIX[action];
}

/** 把理想重跑范围截断到 ceiling；不重跑或 from 超出 ceiling → null（无可执行范围）。 */
export function clampRange(rule: RerunRule, ceiling: Stage): { from: Stage; to: Stage } | null {
  if (!rule.rerun) return null;
  if (stageIndex(rule.from) > stageIndex(ceiling)) return null;
  const to = stageIndex(rule.to) > stageIndex(ceiling) ? ceiling : rule.to;
  return { from: rule.from, to };
}

/** 重试失败阶段：从 failed_stage 跑到截断后的正常终点（完整管线终点为 qa）。 */
export function retryRange(failed: Stage, ceiling: Stage): { from: Stage; to: Stage } {
  const to = stageIndex("qa") > stageIndex(ceiling) ? ceiling : "qa";
  return { from: failed, to };
}

/** 两道用户门的天花板：未确认选片最多跑到 select；未选主题最多跑到 motifs。 */
export function gateCeiling(
  exh: { selection_confirmed_revision: number | null; selected_motif_id: string | null },
  to: Stage,
): Stage {
  if (exh.selection_confirmed_revision == null && stageIndex(to) > stageIndex("select")) return "select";
  if (!exh.selected_motif_id && stageIndex(to) > stageIndex("motifs")) return "motifs";
  return to;
}

/**
 * 统一过期标记（任务书 v2 §5 B2）：取既有 stale_from 与新阶段中更早的一个，
 * 保证多次编辑合并后重跑范围只扩大不缩小。draft/uploading 尚无生成结果，不标记。
 */
export function markStale(db: DatabaseSync, exhibitionId: string, stage: Stage): void {
  const exh = getExhibition(db, exhibitionId);
  if (!exh) return;
  if (exh.status === "draft" || exh.status === "uploading") return;
  const current = exh.stale_from;
  const next =
    current && stageIndex(current) <= stageIndex(stage) ? current : stage;
  if (next !== current) updateExhibition(db, exhibitionId, { stale_from: next });
}

/**
 * 决定变更后的统一失效（任务书 v2.1 §19.5.7，单张/批量/撤销共用）：
 * 保留集变化 → 确认失效 + 状态回到待确认选片 + motifs 过期；否则仅 narrative 过期。
 * forceMotifs 用于单张 must_keep 且用户要求重发现主题。draft/uploading 不做任何标记。
 */
export function invalidateForDecisionChange(
  db: DatabaseSync,
  exh: { id: string; status: string; selection_confirmed_revision: number | null },
  keepSetChanged: boolean,
  forceMotifs = false,
): void {
  if (exh.status === "draft" || exh.status === "uploading") return;
  markStale(db, exh.id, keepSetChanged || forceMotifs ? "motifs" : "narrative");
  if (keepSetChanged && exh.selection_confirmed_revision != null) {
    clearConfirmation(db, exh.id);
    updateExhibition(db, exh.id, { status: "awaiting_selection_confirm" });
  }
}
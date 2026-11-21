import type { DatabaseSync } from "node:sqlite";
import { listPhotos, listInspections } from "../db/photos";
import { listDecisions } from "../db/curation";
import { getMotif } from "../db/motifs";
import { replaceNarrative } from "../db/narrative";
import { listEdits, deleteEdit, deleteEdits } from "../db/edits";
import { getRegenerationIntent, markRegenerationApplied } from "../db/regenerations";
import { getExhibition, updateExhibition } from "../db/repos";
import { getNarrativeAdapter } from "../adapters";
import type { AdapterProvenance, NarrativePhotoInput } from "../adapters/types";
import { indexBySha } from "../demo/manifest";
import { NarrativePlan, type NarrativePlanT, type ToneT } from "./schemas";
import { checkNarrativeCredibility } from "./credibility";
import { mergeNarrative, assertNarrativeStructure, assertNarrativeEdits } from "../orchestrator/merge";
import { snapshotVersion } from "../orchestrator/versions";
import { ApiError } from "../api/errors";
import type { Exhibition, UserEditDTO } from "@/types";

function editedChapterIds(edits: UserEditDTO[]): string[] {
  return [...new Set(edits.flatMap((e) => {
    if (e.target_path.startsWith("chapter:")) return [e.target_path.slice(8).split(".")[0]];
    if (e.target_path === "narrative.chapter_order" && Array.isArray(e.value)) return e.value.filter((v): v is string => typeof v === "string");
    if (e.target_path.startsWith("photo:") && e.target_path.endsWith(".membership") && typeof e.value === "string") return [e.value];
    return [];
  }))];
}

/**
 * Agent 4 叙事编剧（设计文档 §6.5 / §12.6 / 提示词5）。
 * 以所选主题为主线，仅用保留照片（effective ∈ keep/must_keep）的可观察语义/指标组织章节叙事。
 * AI 基线先过 credibility 文本守卫；merge 回放用户编辑/锁定/补回 must_keep 后，再校验结构完整性。
 * 用户编辑拥有最终审美决定权——文本边界只约束 AI 输出，不否决用户改写的文案。
 * 落库后写版本快照并清 stale_from。适配器错误向上传播 → 编排器置 stage_failed，前阶段表不动。
 */
export interface NarrativeOutput {
  title: string;
  chapter_count: number;
  photo_count: number;
  tone: ToneT;
  source: string;
  provenance?: AdapterProvenance;
  preset_hits: number;
  credibility_ok: boolean;
  version: number;
}

export async function runNarrative(
  db: DatabaseSync,
  ctx: { runId: string; workflowId?: string; exhibition: Exhibition; assertOwner?: () => void },
): Promise<NarrativeOutput> {
  const exh = ctx.exhibition;
  ctx.assertOwner?.();
  if (!exh.selected_motif_id) {
    throw new ApiError(409, "theme_not_selected", "请先选择一个主题主线，再生成叙事。");
  }
  const motif = getMotif(db, exh.selected_motif_id);
  if (!motif || motif.exhibition_id !== exh.id) {
    throw new ApiError(409, "theme_not_selected", "所选主题不存在，请重新选择主题主线。");
  }

  const decisions = listDecisions(db, exh.id);
  const keepIds = decisions
    .filter((d) => d.effective_decision === "keep" || d.effective_decision === "must_keep")
    .map((d) => d.photo_id);
  const mustKeepIds = decisions.filter((d) => d.effective_decision === "must_keep").map((d) => d.photo_id);
  const keepSet = new Set(keepIds);
  const photos = listPhotos(db, exh.id).filter((p) => keepSet.has(p.id));
  const inspections = new Map(listInspections(db, exh.id).map((i) => [i.photo_id, i]));

  const inputs: NarrativePhotoInput[] = [];
  let presetHits = 0;
  for (const photo of photos) {
    const ins = inspections.get(photo.id);
    if (!ins) continue;
    if (exh.mode === "demo" && indexBySha(photo.sha256) != null) presetHits++;
    inputs.push({
      photoId: photo.id,
      sha256: photo.sha256,
      subjects: ins.subjects,
      composition_tags: ins.composition_tags,
      visual_facts: ins.visual_facts ?? null,
      color_temp: ins.color_temp ?? null,
      saturation: ins.saturation ?? null,
      brightness_score: ins.brightness_score,
      sharpness_score: ins.sharpness_score,
      duplicate_group_id: ins.duplicate_group_id ?? null,
      sort_order: photo.sort_order,
    });
  }
  if (inputs.length === 0) {
    throw new ApiError(400, "no_keep_photos", "没有保留照片可供叙事，请先在筛选页保留一些照片。");
  }
  if (inputs.length < 2) {
    throw new ApiError(400, "too_few_photos", "至少需要两张保留照片才能组织章节叙事。");
  }

  // R01：重跑意图随 run 预留；语气在生成时即生效，编辑替换留到成功发布时原子应用。
  const intent = getRegenerationIntent(db, ctx.runId);
  const tone = (intent?.tone as ToneT | null) ?? exh.tone;
  const retainedEdits = listEdits(db, exh.id).filter((e) => !intent || intent.scope === "preserve" || (intent.scope === "unlocked" && e.locked));
  const requiredChapterIds = editedChapterIds(retainedEdits);

  const confirmed = getExhibition(db, exh.id);
  if (exh.mode === "ai" && (confirmed?.selection_confirmed_revision == null || confirmed.selection_confirmed_photo_ids == null ||
    confirmed.selection_confirmed_photo_ids.length !== keepSet.size || confirmed.selection_confirmed_photo_ids.some((id) => !keepSet.has(id)))) {
    throw new ApiError(409, "selection_not_confirmed", "选片范围已变化，请重新确认选片。");
  }
  if (exh.mode === "ai" && (
    ["ingest", "select", "motifs"].includes(confirmed?.stale_from ?? "") ||
    motif.photo_ids.some((id) => !keepSet.has(id)) ||
    motif.evidence.some((text) => {
      const id = /^\[([^\]]+)\]\s+/.exec(text)?.[1];
      return !id || !keepSet.has(id) || !motif.photo_ids.includes(id);
    })
  )) {
    throw new ApiError(409, "motif_stale", "主题证据已过期或超出确认选片范围，请先重新发现并选择主题。");
  }
  if (exh.mode === "ai" && inputs.length !== photos.length) {
    throw new ApiError(409, "visual_facts_required", "部分保留照片尚未分析，请先完成 AI 素材分析。");
  }
  const adapter = getNarrativeAdapter(exh.mode, { db, exhibitionId: exh.id, workflowId: ctx.workflowId ?? ctx.runId, assertActive: ctx.assertOwner });
  const output = await adapter.compose({
      motif: {
        motifId: motif.id,
        title: motif.effective_title,
        description: motif.description,
        photo_ids: motif.photo_ids,
        evidence: motif.evidence,
      },
      photos: inputs,
      mustKeepIds,
      tone,
      chapterCount: Math.max(requiredChapterIds.length, Math.min(3, keepSet.size)),
      userIntent: exh.user_intent,
      exhibitionTitle: exh.title,
      regenerationScope: intent?.scope ?? "preserve",
      requiredChapterIds,
    });
  const base = NarrativePlan.parse(output);

  const credCtx = { keepIds, motifPhotoIds: motif.photo_ids };
  const baseReport = checkNarrativeCredibility(base, credCtx);
  if (!baseReport.ok) {
    throw new ApiError(422, "narrative_credibility", "AI 叙事文案未通过可信边界校验，请重试或切换语气。", baseReport.violations);
  }

  const source = output.provenance?.source ?? "unknown";

  // 原子发布：校验 revision → 应用替换意图（删除编辑 + 写语气）→ merge → 结构校验
  // → 写叙事/版本/状态。任何一步失败整体回滚，旧编辑与旧叙事原样保留。
  let plan: NarrativePlanT;
  let version: number;
  db.exec("BEGIN IMMEDIATE");
  try {
    ctx.assertOwner?.();
    const current = getExhibition(db, exh.id);
    const publishIntent = getRegenerationIntent(db, ctx.runId);
    if (!current || current.input_revision !== exh.input_revision ||
      (intent && (!publishIntent || publishIntent.state !== "pending" ||
        publishIntent.expected_input_revision !== current.input_revision))) {
      throw new ApiError(409, "version_conflict", "内容已在其他操作中更新，你的草稿已保留，请查看最新内容后再保存。");
    }
    let edits = listEdits(db, exh.id);
    if (publishIntent) {
      if (publishIntent.scope === "all") deleteEdits(db, exh.id);
      else if (publishIntent.scope === "unlocked") {
        for (const e of edits) if (!e.locked) deleteEdit(db, exh.id, e.target_path);
      }
      if (publishIntent.tone) updateExhibition(db, exh.id, { tone: publishIntent.tone as ToneT });
      markRegenerationApplied(db, ctx.runId);
      edits = listEdits(db, exh.id);
    }

    const mergeContext = { keepIds, mustKeepIds, motifPhotoIds: motif.photo_ids };
    assertNarrativeStructure(base, mergeContext, false);
    assertNarrativeEdits(base, edits, mergeContext);
    plan = mergeNarrative(base, edits, mergeContext);
    assertNarrativeStructure(plan, mergeContext);
    assertNarrativeEdits(plan, edits, mergeContext, true);
    replaceNarrative(db, exh.id, plan, {
      source,
      inputVersion: exh.current_version,
      runId: ctx.runId,
      selectedMotifId: motif.id,
    });
    version = snapshotVersion(db, exh.id, "叙事生成");
    updateExhibition(db, exh.id, { stale_from: null });
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return {
    title: plan.title,
    chapter_count: plan.chapters.length,
    photo_count: inputs.length,
    tone: plan.tone,
    source,
    provenance: output.provenance,
    preset_hits: presetHits,
    credibility_ok: true,
    version,
  };
}

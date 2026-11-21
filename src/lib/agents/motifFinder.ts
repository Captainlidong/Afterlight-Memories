import type { DatabaseSync } from "node:sqlite";
import { listPhotos, listInspections } from "../db/photos";
import { listDecisions } from "../db/curation";
import { replaceMotifs, listMotifs } from "../db/motifs";
import { getNarrative } from "../db/narrative";
import { getExhibition, updateExhibition } from "../db/repos";
import { getMotifAdapter } from "../adapters";
import type { AdapterProvenance, MotifPhotoInput } from "../adapters/types";
import { indexBySha } from "../demo/manifest";
import { MotifResult } from "./schemas";
import { ApiError } from "../api/errors";
import type { Exhibition } from "@/types";

/**
 * Agent 3 主题发现官（设计文档 §6.4 / §12.5 / 提示词4）。
 * 仅从保留照片（effective ∈ keep/must_keep）的可观察语义/色彩/构图聚类出 2–4 个候选主题，
 * 证据串由真实计数生成，每个候选附替代理解，防止过度解读、绝不编造个人经历。
 * replaceMotifs 单事务落库并按标题延续用户改名与已选主线（主线消失才回主题门）。
 * 适配器错误（AI 未配置）向上传播 → 编排器置 stage_failed，前阶段表不动。
 */
export interface MotifsOutput {
  count: number;
  photo_count: number;
  preset_hits: number;
  heuristic_count: number;
  provenance?: AdapterProvenance;
}

export async function runMotifs(
  db: DatabaseSync,
  ctx: { runId: string; workflowId?: string; exhibition: Exhibition; assertOwner?: () => void },
): Promise<MotifsOutput> {
  const exh = ctx.exhibition;
  const keepIds = new Set(
    listDecisions(db, exh.id)
      .filter((d) => d.effective_decision === "keep" || d.effective_decision === "must_keep")
      .map((d) => d.photo_id),
  );
  const photos = listPhotos(db, exh.id).filter((p) => keepIds.has(p.id));
  const inspections = new Map(listInspections(db, exh.id).map((i) => [i.photo_id, i]));

  const inputs: MotifPhotoInput[] = [];
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
      duplicate_group_id: ins.duplicate_group_id ?? null,
    });
  }
  if (inputs.length === 0) {
    throw new ApiError(400, "no_keep_photos", "没有保留照片可供主题发现，请先在筛选页保留一些照片。");
  }

  const confirmed = getExhibition(db, exh.id);
  if (exh.mode === "ai" && (confirmed?.selection_confirmed_revision == null || confirmed.selection_confirmed_photo_ids == null ||
    confirmed.selection_confirmed_photo_ids.length !== keepIds.size || confirmed.selection_confirmed_photo_ids.some((id) => !keepIds.has(id)))) {
    throw new ApiError(409, "selection_not_confirmed", "选片范围已变化，请重新确认选片，再开始主题发现。");
  }
  if (exh.mode === "ai" && inputs.length !== photos.length) {
    throw new ApiError(409, "visual_facts_required", "部分保留照片尚未分析，请先完成 AI 素材分析。");
  }
  const adapter = getMotifAdapter(exh.mode, { db, exhibitionId: exh.id, workflowId: ctx.workflowId ?? ctx.runId, assertActive: ctx.assertOwner });
  const output = await adapter.discover({ photos: inputs, prefs: exh.aesthetic_prefs, userIntent: exh.user_intent });
  const result = MotifResult.parse(output);

  db.exec("BEGIN IMMEDIATE");
  try {
    ctx.assertOwner?.();
    replaceMotifs(db, exh.id, result.motifs, ctx.runId);
    // 候选、主线延续及 stale 同时发布；replaceMotifs 复用本事务。
    const selected = getNarrative(db, exh.id) ? getExhibition(db, exh.id)!.selected_motif_id : null;
    updateExhibition(db, exh.id, { stale_from: selected ? "narrative" : null });
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }

  return {
    count: listMotifs(db, exh.id).length,
    photo_count: inputs.length,
    preset_hits: presetHits,
    heuristic_count: exh.mode === "demo" ? inputs.length - presetHits : 0,
    provenance: output.provenance,
  };
}

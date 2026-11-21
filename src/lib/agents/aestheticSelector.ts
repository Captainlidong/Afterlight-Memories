import type { DatabaseSync } from "node:sqlite";
import { listPhotos, listInspections } from "../db/photos";
import { upsertAiDecision, listDecisions } from "../db/curation";
import { listMotifs } from "../db/motifs";
import { markStale } from "../orchestrator/rerunMatrix";
import { getCurationAdapter } from "../adapters";
import type { AdapterProvenance, CurationPhotoInput } from "../adapters/types";
import { clearConfirmation } from "../db/repos";
import { indexBySha } from "../demo/manifest";
import { CurationResult } from "./schemas";
import { ApiError } from "../api/errors";
import type { Exhibition } from "@/types";

/**
 * Agent 2 审美筛选官（设计文档 §6.3 / 提示词3）。
 * 从已分析照片的可观察指标 + 重复关系 + 语义标签推 keep/hold/remove 与人类可读理由。
 * 只写 ai_* 列：user_override（含 must_keep）结构上不被触碰，重跑不覆盖用户决定。
 * 适配器错误（AI 未配置）向上传播 → 编排器置 stage_failed，前分析表不动。
 */
export interface SelectOutput {
  total: number;
  kept: number;
  held: number;
  removed: number;
  must_kept: number;
  preset_hits: number;
  heuristic_count: number;
  provenance?: AdapterProvenance;
}

export async function runSelect(
  db: DatabaseSync,
  ctx: { runId: string; workflowId?: string; exhibition: Exhibition; assertOwner?: () => void },
): Promise<SelectOutput> {
  const exh = ctx.exhibition;
  const photos = listPhotos(db, exh.id);
  const inspections = new Map(listInspections(db, exh.id).map((i) => [i.photo_id, i]));

  const inputs: CurationPhotoInput[] = [];
  let presetHits = 0;
  for (const photo of photos) {
    const ins = inspections.get(photo.id);
    if (!ins) continue; // 未分析的照片不参与筛选（坏文件/未 ingest）
    if (exh.mode === "demo" && indexBySha(photo.sha256) != null) presetHits++;
    inputs.push({
      photoId: photo.id,
      sha256: photo.sha256,
      sharpness_score: ins.sharpness_score,
      brightness_score: ins.brightness_score,
      highlight_clip_ratio: ins.highlight_clip_ratio,
      shadow_clip_ratio: ins.shadow_clip_ratio,
      color_temp: ins.color_temp ?? null,
      saturation: ins.saturation ?? null,
      subjects: ins.subjects,
      composition_tags: ins.composition_tags,
      visual_facts: ins.visual_facts ?? null,
      duplicate_group_id: ins.duplicate_group_id ?? null,
    });
  }
  if (inputs.length === 0) {
    throw new ApiError(400, "no_inspections", "没有已分析的照片可供筛选，请先完成素材分析。");
  }

  if (exh.mode === "ai" && inputs.length !== photos.length) {
    throw new ApiError(409, "visual_facts_required", "部分照片尚未分析，请先完成 AI 素材分析。");
  }
  const beforeKeep = new Set(listDecisions(db, exh.id).filter((d) => d.effective_decision === "keep" || d.effective_decision === "must_keep").map((d) => d.photo_id));
  const adapter = getCurationAdapter(exh.mode, { db, exhibitionId: exh.id, workflowId: ctx.workflowId ?? ctx.runId, assertActive: ctx.assertOwner });
  const output = await adapter.curate({ photos: inputs, prefs: exh.aesthetic_prefs });
  const result = CurationResult.parse(output);

  db.exec("BEGIN IMMEDIATE");
  try {
    ctx.assertOwner?.();
    for (const d of result.decisions) {
      upsertAiDecision(db, exh.id, d, ctx.runId);
    }
    const afterKeep = listDecisions(db, exh.id).filter((d) => d.effective_decision === "keep" || d.effective_decision === "must_keep").map((d) => d.photo_id);
    if (afterKeep.length !== beforeKeep.size || afterKeep.some((id) => !beforeKeep.has(id))) clearConfirmation(db, exh.id);
    // 产物、确认失效和下游 stale 必须同时提交。
    if (listMotifs(db, exh.id).length > 0) markStale(db, exh.id, "motifs");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const decisions = listDecisions(db, exh.id);
  const count = (d: string) => decisions.filter((x) => x.effective_decision === d).length;
  return {
    total: decisions.length,
    kept: count("keep"),
    held: count("hold"),
    removed: count("remove"),
    must_kept: count("must_keep"),
    preset_hits: presetHits,
    heuristic_count: exh.mode === "demo" ? inputs.length - presetHits : 0,
    provenance: output.provenance,
  };
}

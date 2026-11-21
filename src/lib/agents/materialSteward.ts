import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { listPhotos, updatePhoto, upsertInspection } from "../db/photos";
import { updateRun } from "../db/runs";
import { analyzeImage, type ImageAnalysis } from "../image/pipeline";
import { prepareForAi } from "../image/prepareForAi";
import { loadAiConfig } from "../ai/config";
import { AiError, AiStaleContextError } from "../ai/errors";
import { ApiError } from "../api/errors";
import { groupDuplicates, countDuplicateGroups } from "../image/duplicates";
import { getVisionAdapter } from "../adapters";
import { toAbsolute } from "../files";
import { PhotoInspection, type PhotoInspectionT } from "./schemas";
import type { Exhibition } from "@/types";

/**
 * Agent 1 素材管家（设计文档 §6.2）。两模式都真跑 sharp 指标。
 * 逐文件 try/catch：坏文件只标该行 failed，不影响其余（§11.2 / §17.1）。
 * 适配器错误（AI 未配置）向上传播 → 编排器置 stage_failed，不污染照片行。
 * 技术分析只是证据，绝不据此删除照片。
 */
export interface IngestOutput {
  total: number;
  reused: number;
  newly_completed: number;
  pending: number;
  photo_results: { photo_id: string; status: "completed" | "reused" | "failed"; call_id: string | null }[];
  processed: number;
  failed: number;
  failed_photos: { photo_id: string; message: string }[];
  duplicate_groups: number;
  inspected_photo_ids: string[];
}

interface Analyzed {
  photoId: string;
  sha256: string;
  analysis: ImageAnalysis;
}

export async function runIngest(
  db: DatabaseSync,
  ctx: { runId: string; workflowId?: string; exhibition: Exhibition; assertOwner?: () => void },
): Promise<IngestOutput> {
  const exh = ctx.exhibition;
  // 调用层和落库层用同一失效语义，防止把失去执行权误标成一张坏照片。
  // 编排器会重新核验 fence 并记录具体 lease/revision 原因；其他 API 错误原样传播。
  const assertActive = () => {
    try { ctx.assertOwner?.(); }
    catch (error) {
      if (error instanceof ApiError && error.code === "run_fenced") throw new AiStaleContextError();
      throw error;
    }
  };
  assertActive();
  const aiConfig = exh.mode === "ai" ? loadAiConfig() : null;
  const photos = listPhotos(db, exh.id);
  if (aiConfig && photos.length > aiConfig.maxPhotosPerJob) {
    throw new ApiError(
      400,
      "too_many_photos_for_ai",
      `真实 AI 单次最多分析 ${aiConfig.maxPhotosPerJob} 张照片，当前为 ${photos.length} 张。请减少照片或由作者调整服务端上限。`,
    );
  }
  const adapter = getVisionAdapter(exh.mode, aiConfig ? {
    db,
    config: aiConfig,
    getCurrentConfig: loadAiConfig,
    // 与正式发布使用同一任务守卫：排队、缓存命中和外发前也必须核对租约及冻结输入。
    assertActive,
  } : undefined);
  const analyzed: Analyzed[] = [];
  const failed: { photo_id: string; message: string }[] = [];
  let fatalError: unknown = null;
  const photoResults: IngestOutput["photo_results"] = [];
  const progress = (duplicateGroups = 0): IngestOutput => {
    const reused = photoResults.filter(p => p.status === "reused").length;
    const completed = photoResults.filter(p => p.status === "completed").length;
    return {
      total: photos.length, processed: reused + completed, reused, newly_completed: completed,
      pending: photos.length - photoResults.length, photo_results: photoResults,
      failed: failed.length, failed_photos: failed, duplicate_groups: duplicateGroups,
      inspected_photo_ids: photoResults.filter(p => p.status !== "failed").map(p => p.photo_id),
    };
  };
  const publish = (write: () => void) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      assertActive();
      write();
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };
  publish(() => updateRun(db, ctx.runId, { output: progress() }));

  for (const photo of photos) {
    // Explicit stage retries revisit inputs, including previously failed photos.
    let analysis: ImageAnalysis;
    let inspection: PhotoInspectionT;
    let sourceCallId: string | null = null;
    try {
      const buffer = fs.readFileSync(toAbsolute(photo.storage_path));
      analysis = await analyzeImage(buffer, { allowExif: exh.allow_exif });
      const image = aiConfig
        ? await prepareForAi(buffer, { maxEdge: aiConfig.imageMaxEdge })
        : undefined;
      const desc = await adapter.describePhoto({
        photoId: photo.id,
        exhibitionId: exh.id,
        workflowId: ctx.workflowId ?? ctx.runId,
        sha256: photo.sha256,
        image,
        metrics: {
          sharpness_score: analysis.sharpness_score,
          brightness_score: analysis.brightness_score,
          highlight_clip_ratio: analysis.highlight_clip_ratio,
          shadow_clip_ratio: analysis.shadow_clip_ratio,
          color_temp: analysis.color_temp,
          saturation: analysis.saturation,
          dominant_colors: analysis.dominant_colors,
        },
      });
      sourceCallId = desc.source_call_id ?? null;
      inspection = PhotoInspection.parse({
        photo_id: photo.id,
        sharpness_score: analysis.sharpness_score,
        laplacian_var: analysis.laplacian_var,
        brightness_score: analysis.brightness_score,
        highlight_clip_ratio: analysis.highlight_clip_ratio,
        shadow_clip_ratio: analysis.shadow_clip_ratio,
        dominant_colors: analysis.dominant_colors,
        color_temp: analysis.color_temp,
        saturation: analysis.saturation,
        subjects: desc.subjects,
        composition_tags: desc.composition_tags,
        visual_embedding: desc.visual_embedding,
        visual_facts: desc.visual_facts ?? null,
        visual_source: desc.visual_source ?? null,
        analysis_image_sha256: desc.analysis_image_sha256 ?? null,
        duplicate_group_id: null,
        processing_mode: desc.processing_mode,
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === "run_fenced") throw err;
      if (err instanceof AiError && ["cancelled", "stale_context"].includes(err.cls)) throw err;
      const message = err instanceof AiError ? err.message : "图片读取或分析失败，请检查素材后重试。";
      const fatal = err instanceof AiError && ["config", "unauthorized", "budget", "auth", "quota", "queue"].includes(err.cls);
      publish(() => {
        if (!fatal) updatePhoto(db, photo.id, { status: "failed", error_message: message });
        failed.push({ photo_id: photo.id, message });
        photoResults.push({ photo_id: photo.id, status: "failed", call_id: null });
        updateRun(db, ctx.runId, { output: progress() });
      });
      if (fatal) { fatalError = err; break; }
      continue;
    }

    publish(() => {
      upsertInspection(db, inspection);
      updatePhoto(db, photo.id, {
        status: "inspected",
        phash: analysis.phash,
        exif_json: JSON.stringify(analysis.exif),
        has_exif: analysis.exif.has_exif ? 1 : 0,
        error_message: null,
      });
      photoResults.push({ photo_id: photo.id, status: inspection.visual_source === "cache" ? "reused" : "completed", call_id: sourceCallId });
      updateRun(db, ctx.runId, { output: progress() });
    });
    analyzed.push({ photoId: photo.id, sha256: photo.sha256, analysis });
  }

  const dupMap = groupDuplicates(
    analyzed.map((a) => ({ id: a.photoId, sha256: a.sha256, phash: a.analysis.phash })),
  );

  publish(() => {
    const updateGroup = db.prepare("UPDATE photo_inspections SET duplicate_group_id=? WHERE photo_id=?");
    for (const a of analyzed) {
      updateGroup.run(dupMap.get(a.photoId) ?? null, a.photoId);
    }
    updateRun(db, ctx.runId, { output: progress(countDuplicateGroups(dupMap)) });
  });

  if (fatalError) throw fatalError;
  if (exh.mode === "ai" && failed.length > 0) {
    throw new ApiError(
      422,
      "vision_incomplete",
      `已分析 ${analyzed.length}/${photos.length} 张，失败 ${failed.length} 张。成功结果已保存，请重试失败项或排除失败照片后重新确认范围。`,
    );
  }
  return progress(countDuplicateGroups(dupMap));
}

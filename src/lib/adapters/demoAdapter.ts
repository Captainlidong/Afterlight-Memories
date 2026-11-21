import { indexBySha, demoInspection } from "../demo/manifest";
import type { VisionAdapter, VisionInput, VisionDescription, VisionMetrics } from "./types";

/**
 * Demo 适配器（设计文档 §9.3）：
 * - sha256 命中 manifest → 套用预设语义标签（processing_mode='demo'）；
 * - 未命中（用户自有照片）→ 确定性启发式，仅从可观察指标推标签（'heuristic'）。
 * 启发式绝不臆造物体/人物/关系（§13.3），只描述光线/色彩/清晰度等可测事实。
 */
function heuristicTags(m: VisionMetrics): { subjects: string[]; composition_tags: string[] } {
  const tags: string[] = [];
  if (m.color_temp <= -0.12) tags.push("冷调光线");
  else if (m.color_temp >= 0.12) tags.push("暖调光线");
  if (m.brightness_score >= 0.68) tags.push("明亮");
  else if (m.brightness_score <= 0.3) tags.push("低光");
  if (m.highlight_clip_ratio >= 0.12) tags.push("高光溢出");
  if (m.shadow_clip_ratio >= 0.2) tags.push("大面积阴影");
  if (m.saturation <= 0.12) tags.push("低饱和");
  else if (m.saturation >= 0.5) tags.push("高饱和");
  if (m.sharpness_score <= 0.3) tags.push("柔焦");
  else if (m.sharpness_score >= 0.7) tags.push("高清晰");
  return { subjects: [], composition_tags: tags };
}

export const demoVisionAdapter: VisionAdapter = {
  async describePhoto(input: VisionInput): Promise<VisionDescription> {
    const idx = indexBySha(input.sha256);
    if (idx != null) {
      const preset = demoInspection(idx);
      return {
        subjects: preset?.subjects ?? [],
        composition_tags: preset?.composition_tags ?? [],
        visual_embedding: null,
        processing_mode: "demo",
      };
    }
    const { subjects, composition_tags } = heuristicTags(input.metrics);
    return { subjects, composition_tags, visual_embedding: null, processing_mode: "heuristic" };
  },
};
import { indexBySha, demoCuration } from "../demo/manifest";
import type { AestheticPrefsT, CurationDecisionT, CurationResultT } from "../agents/schemas";
import type { AdapterResult, CurationAdapter, CurationInput, CurationPhotoInput } from "./types";

/**
 * Demo 审美筛选适配器（设计文档 §6.3 / §9.3 / 提示词3）。
 * - sha256 命中 manifest → 套用 curation.json 预设决定（24→17 故事）；
 * - 未命中（用户自有照片）→ 确定性启发式，仅从可观察指标推决定与理由。
 * 启发式绝不把"低清晰度"等价为"没有价值"：独特但模糊 → hold，交由用户决定。
 * 自动 remove 仅保留给"严重模糊且明显劣于更清晰孪生"的冗余近重复。
 */
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

const INTEREST_TAGS = [
  "框景", "背影", "引导线", "反光", "转折", "逆光", "留白", "大留白",
  "几何", "明暗对比", "纵深", "一点透视", "节奏", "剪影",
];
const FOCUS_TAGS: Record<string, string[]> = {
  light: ["冷调", "暖调", "光束", "逆光", "侧光", "晨光", "黄昏", "蓝调时刻", "金色阳光", "高光"],
  color: ["冷调", "暖调", "低饱和", "高饱和", "蓝调"],
  space: ["留白", "大留白", "纵深", "一点透视", "空旷"],
  people: ["背影", "人物", "剪影", "小主体"],
  architecture: ["框景", "引导线", "柱列", "几何", "门洞", "拱门", "走廊"],
};

function tagsOf(p: CurationPhotoInput): string[] {
  return [...p.composition_tags, ...p.subjects];
}

function compositionInterest(p: CurationPhotoInput, prefs: AestheticPrefsT): number {
  const tags = tagsOf(p);
  let interest = 0.3;
  interest += 0.16 * INTEREST_TAGS.filter((t) => tags.includes(t)).length;
  for (const f of prefs.focus) {
    if ((FOCUS_TAGS[f] ?? []).some((t) => tags.includes(t))) interest += 0.18;
  }
  return clamp01(interest);
}

function scorePhoto(p: CurationPhotoInput, prefs: AestheticPrefsT): number {
  const clipPenalty = Math.max(p.highlight_clip_ratio, p.shadow_clip_ratio * 0.6);
  const brightBalance = clamp01(1 - Math.abs(p.brightness_score - 0.5) * 1.2);
  const satScore = clamp01(1 - Math.abs((p.saturation ?? 0.3) - 0.35) * 1.5);
  const unique = p.duplicate_group_id ? 0.55 : 1;
  const s =
    0.34 * p.sharpness_score +
    0.18 * brightBalance +
    0.12 * satScore +
    0.16 * unique +
    0.2 * compositionInterest(p, prefs) -
    0.25 * clipPenalty;
  return clamp01(s);
}

function keepReasons(p: CurationPhotoInput): string[] {
  const r: string[] = [];
  if (p.sharpness_score >= 0.6) r.push("清晰度良好，技术质量稳定");
  const tag = INTEREST_TAGS.find((t) => tagsOf(p).includes(t));
  if (tag) r.push(`构图具备「${tag}」特征，视觉强度突出`);
  if (!p.duplicate_group_id) r.push("在整组中提供独特视角");
  if (r.length === 0) r.push("技术质量与整组贡献达到保留标准");
  return r;
}

const CONFIDENCE = { keep: 0.6, hold: 0.5, remove: 0.55 } as const;

/** 确定性启发式筛选（纯函数，可独立测试）。重复组最佳 keep，其余 hold；严重劣化冗余才 remove。 */
export function heuristicCurate(
  photos: CurationPhotoInput[],
  prefs: AestheticPrefsT,
): CurationDecisionT[] {
  const scored = photos.map((p) => ({ p, score: scorePhoto(p, prefs) }));
  const scoreOf = new Map(scored.map((s) => [s.p.photoId, s.score]));
  const groups = new Map<string, CurationPhotoInput[]>();
  for (const p of photos) {
    if (!p.duplicate_group_id) continue;
    const arr = groups.get(p.duplicate_group_id) ?? [];
    arr.push(p);
    groups.set(p.duplicate_group_id, arr);
  }
  const allowDupRemove = prefs.repetition === "fewer";
  const out: CurationDecisionT[] = [];

  for (const p of photos) {
    const score = scoreOf.get(p.photoId)!;
    const group = p.duplicate_group_id ? groups.get(p.duplicate_group_id) : undefined;

    if (group && group.length >= 2) {
      const best = group.reduce((a, b) => (scoreOf.get(b.photoId)! > scoreOf.get(a.photoId)! ? b : a));
      const related = group.filter((g) => g.photoId !== p.photoId).map((g) => g.photoId);
      if (p.photoId === best.photoId) {
        out.push({
          photo_id: p.photoId, decision: "keep", score, confidence: CONFIDENCE.keep,
          reasons: ["同组中技术质量与构图最佳", "作为该重复视角的代表保留"],
          related_photo_ids: related, user_override_allowed: true,
        });
      } else if (allowDupRemove && best.sharpness_score - p.sharpness_score > 0.3 && p.sharpness_score < 0.3) {
        out.push({
          photo_id: p.photoId, decision: "remove", score, confidence: CONFIDENCE.remove,
          reasons: ["与同组更清晰照片高度重复且明显劣化", "信息冗余，保留同组最佳一张即可代表该视角"],
          related_photo_ids: related, user_override_allowed: true,
        });
      } else {
        out.push({
          photo_id: p.photoId, decision: "hold", score, confidence: CONFIDENCE.hold,
          reasons: ["与同组照片视角相近，构成重复风险", "建议暂缓，由你决定保留哪一张"],
          related_photo_ids: related, user_override_allowed: true,
        });
      }
      continue;
    }

    if (p.highlight_clip_ratio > 0.25) {
      out.push({
        photo_id: p.photoId, decision: "hold", score, confidence: CONFIDENCE.hold,
        reasons: ["高光溢出较多，可能过曝", "是否保留这种高调效果交由你判断"],
        related_photo_ids: [], user_override_allowed: true,
      });
    } else if (p.sharpness_score < 0.3) {
      out.push({
        photo_id: p.photoId, decision: "hold", score, confidence: CONFIDENCE.hold,
        reasons: ["清晰度偏低，技术上不够稳定", "但画面在整组中独特，建议暂缓而非直接移除，最终决定权在你"],
        related_photo_ids: [], user_override_allowed: true,
      });
    } else if (score >= 0.45) {
      out.push({
        photo_id: p.photoId, decision: "keep", score, confidence: CONFIDENCE.keep,
        reasons: keepReasons(p), related_photo_ids: [], user_override_allowed: true,
      });
    } else {
      out.push({
        photo_id: p.photoId, decision: "hold", score, confidence: CONFIDENCE.hold,
        reasons: ["技术质量中等，独特性一般", "建议暂缓，由你决定是否纳入影展"],
        related_photo_ids: [], user_override_allowed: true,
      });
    }
  }
  return out;
}

export const demoCurationAdapter: CurationAdapter = {
  async curate(input: CurationInput): Promise<AdapterResult<CurationResultT>> {
    const { photos, prefs } = input;
    const indexToPhotoId = new Map<number, string>();
    for (const p of photos) {
      const idx = indexBySha(p.sha256);
      if (idx != null) indexToPhotoId.set(idx, p.photoId);
    }
    // 先对全部照片跑启发式（保证混合批次的重复组关系正确），再用预设覆盖命中张。
    const byId = new Map(heuristicCurate(photos, prefs).map((d) => [d.photo_id, d]));
    let presetCount = 0;
    for (const p of photos) {
      const idx = indexBySha(p.sha256);
      const preset = idx != null ? demoCuration(idx) : null;
      if (!preset) continue;
      presetCount++;
      byId.set(p.photoId, {
        photo_id: p.photoId,
        decision: preset.decision,
        score: preset.score,
        confidence: preset.confidence,
        reasons: preset.reasons,
        related_photo_ids: preset.related_indices
          .map((i) => indexToPhotoId.get(i))
          .filter((x): x is string => typeof x === "string"),
        user_override_allowed: true,
      });
    }
    return {
      decisions: photos.map((p) => byId.get(p.photoId)!),
      provenance: { source: presetCount === 0 ? "heuristic" : presetCount === photos.length ? "demo_preset" : "mixed" },
    };
  },
};
import { indexBySha, demoNarrative } from "../demo/manifest";
import type { ChapterT, NarrativePlanT, PlacementReasonT } from "../agents/schemas";
import type { AdapterResult, NarrativeAdapter, NarrativeInput, NarrativePhotoInput } from "./types";

/**
 * Demo 叙事编剧适配器（设计文档 §6.5 / §9.3 / §12.6 / 提示词5）。
 * - sha256 大多命中 manifest → 套用 narrative.json 预设（《在光线转弯之前》三章 + 4 语气）；
 * - 否则（用户自有照片）→ 确定性启发式：开场=最空间感、转折=最亮 outlier、结尾=最低饱和，
 *   按空间→经过→安静分段，绝不只按分数排序。文案只描述可观察的组织方式，不编造经历/关系。
 * 用户编辑/锁定/must_keep 调和由 merge.ts 在落库前处理，适配器只产出 AI 基线。
 */
const SPATIAL_TAGS = ["留白", "大留白", "纵深", "框景", "一点透视", "窗", "窗格", "门洞", "拱门", "走廊", "几何"];
const PEOPLE_TAGS = ["背影", "人物", "人物背影", "剪影", "小主体"];
const QUIET_TAGS = ["反光", "倒影", "水面", "玻璃", "镜面", "空椅", "静物"];

const tagsOf = (p: NarrativePhotoInput) => [...p.composition_tags, ...p.subjects];
const countTags = (p: NarrativePhotoInput, list: string[]) => list.filter((t) => tagsOf(p).includes(t)).length;
const sat = (p: NarrativePhotoInput) => p.saturation ?? 0.3;
const topTag = (p: NarrativePhotoInput) => p.composition_tags[0] ?? p.subjects[0] ?? "画面";
const clampTitle = (s: string) => [...s].slice(0, 60).join("");

function phaseScore(p: NarrativePhotoInput): number {
  if (countTags(p, QUIET_TAGS) > 0) return 2;
  if (countTags(p, PEOPLE_TAGS) > 0) return 1;
  if (countTags(p, SPATIAL_TAGS) > 0) return 0;
  return 1;
}

function chapterDescription(position: "first" | "middle" | "last", chunk: NarrativePhotoInput[]): string {
  const freq = new Map<string, number>();
  for (const p of chunk) for (const t of p.composition_tags) freq.set(t, (freq.get(t) ?? 0) + 1);
  const tag = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "画面";
  if (position === "first") return `以「${tag}」开场，先建立空间与观看方向。`;
  if (position === "middle") return `「${tag}」在中段反复出现，构成经过的节奏。`;
  return `以「${tag}」收束，让观看在安静处停下。`;
}

/** 确定性启发式叙事（纯函数，可独立测试）。锚点=空间/明亮/安静，而非分数排序。 */
export function heuristicNarrative(input: NarrativeInput): NarrativePlanT {
  const photos = [...input.photos].sort((a, b) => a.sort_order - b.sort_order);
  const n = photos.length;
  const chapterCount = Math.max(2, Math.min(input.chapterCount ?? 3, n, 3));

  const opening = photos.reduce((a, b) =>
    countTags(b, SPATIAL_TAGS) > countTags(a, SPATIAL_TAGS) ||
    (countTags(b, SPATIAL_TAGS) === countTags(a, SPATIAL_TAGS) && b.brightness_score > a.brightness_score)
      ? b
      : a,
  );
  const turning =
    n >= 3
      ? photos.filter((p) => p.photoId !== opening.photoId).reduce((a, b) => (b.brightness_score > a.brightness_score ? b : a))
      : null;
  const closingPool = photos.filter((p) => p.photoId !== opening.photoId && p.photoId !== turning?.photoId);
  const closing = closingPool.reduce((a, b) =>
    sat(b) < sat(a) || (sat(b) === sat(a) && b.brightness_score < a.brightness_score) ? b : a,
  );

  const anchorIds = new Set([opening.photoId, turning?.photoId, closing.photoId]);
  const remaining = photos
    .filter((p) => !anchorIds.has(p.photoId))
    .sort((a, b) => phaseScore(a) - phaseScore(b) || a.sort_order - b.sort_order);
  const sequence = [opening, ...remaining, closing];
  if (turning) sequence.splice(Math.floor(sequence.length / 2), 0, turning);

  const base = Math.floor(n / chapterCount);
  const extra = n % chapterCount;
  const chunks: NarrativePhotoInput[][] = [];
  let cursor = 0;
  for (let i = 0; i < chapterCount; i++) {
    const size = base + (i < extra ? 1 : 0);
    chunks.push(sequence.slice(cursor, cursor + size));
    cursor += size;
  }

  const titles = chapterCount === 2 ? ["进入", "留下"] : ["进入", "经过", "留下"];
  const chapters: ChapterT[] = chunks.map((chunk, i) => {
    const position = i === 0 ? "first" : i === chapterCount - 1 ? "last" : "middle";
    const reasons: PlacementReasonT[] = [];
    const first = chunk[0];
    const last = chunk[chunk.length - 1];
    if (first.photoId === opening.photoId) {
      reasons.push({ photo_id: opening.photoId, role: "opening", reason: `作为开场：「${topTag(opening)}」先呈现空间，建立整组的观看方向。` });
    }
    if (turning && chunk.some((p) => p.photoId === turning.photoId)) {
      reasons.push({ photo_id: turning.photoId, role: "turning", reason: "作为转折：亮度高于整组，形成明暗节奏中的呼吸点。" });
    }
    if (last.photoId === closing.photoId && last.photoId !== first.photoId) {
      reasons.push({ photo_id: closing.photoId, role: "closing", reason: `作为结尾：低饱和的「${topTag(closing)}」让观看在安静处收束。` });
    }
    return {
      id: `chapter_${String(i + 1).padStart(2, "0")}`,
      title: titles[i],
      description: chapterDescription(position, chunk),
      photo_ids: chunk.map((p) => p.photoId),
      opening_photo_id: first.photoId,
      closing_photo_id: last.photoId,
      placement_reasons: reasons,
      locked: false,
    };
  });

  const curatorial =
    chapterCount === 2
      ? "整组按空间与安静两段组织：先让空间出现，最后在安静处收束。"
      : "整组按空间、经过与安静三段组织：先让空间出现，再让人物经过，最后在安静处收束。";

  return {
    selected_motif_id: input.motif.motifId,
    title: clampTitle(input.exhibitionTitle?.trim() || "留影叙事"),
    subtitle: "由保留照片自动组织的观看线索",
    curatorial_statement: curatorial,
    chapters,
    tone: input.tone,
  };
}

export const demoNarrativeAdapter: NarrativeAdapter = {
  async compose(input: NarrativeInput): Promise<AdapterResult<NarrativePlanT>> {
    const { photos, tone } = input;
    const hits = photos.filter((p) => indexBySha(p.sha256) != null).length;
    const usePreset = photos.length > 0 && hits / photos.length >= 0.8;

    if (usePreset) {
      const indexToPhotoId = new Map<number, string>();
      for (const p of photos) {
        const idx = indexBySha(p.sha256);
        if (idx != null) indexToPhotoId.set(idx, p.photoId);
      }
      const preset = demoNarrative();
      const tonePreset = preset.tones[tone] ?? preset.tones.restrained;
      const chapters: ChapterT[] = preset.chapters
        .map((c, i) => {
          const photo_ids = c.photo_indices
            .map((idx) => indexToPhotoId.get(idx))
            .filter((x): x is string => typeof x === "string");
          const placement_reasons: PlacementReasonT[] = tonePreset.placement_reasons
            .filter((pr) => pr.chapter === c.id)
            .map((pr) => ({ photo_id: indexToPhotoId.get(pr.index), role: pr.role, reason: pr.reason }))
            .filter((pr): pr is PlacementReasonT => typeof pr.photo_id === "string" && photo_ids.includes(pr.photo_id));
          return {
            id: c.id,
            title: c.title,
            description: tonePreset.descriptions[i] ?? "",
            photo_ids,
            opening_photo_id: photo_ids[0],
            closing_photo_id: photo_ids[photo_ids.length - 1],
            placement_reasons,
            locked: false,
          };
        })
        .filter((c) => c.photo_ids.length >= 1);

      if (chapters.length >= 2) {
        return {
          selected_motif_id: input.motif.motifId,
          title: preset.title,
          subtitle: preset.subtitle,
          curatorial_statement: tonePreset.curatorial_statement,
          chapters,
          tone,
          provenance: { source: "demo_preset" },
        };
      }
    }

    return { ...heuristicNarrative(input), provenance: { source: "heuristic" } };
  },
};

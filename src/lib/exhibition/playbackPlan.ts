import type { ChapterT, LayoutSectionT } from "@/lib/agents/schemas";

/**
 * 放映路线（§19.8）：纯函数，从布局 section 生成停靠点与确定性停留节奏。
 * 浏览页与离线导出共用同一路线事实源——导出时把路线序列化为 JSON 内嵌，
 * 内联脚本只执行路线，不另行推导 section 语义，避免两套相反的时间规则。
 */

export type ViewableSectionType =
  | "hero"
  | "chapter_intro"
  | "statement"
  | "single_image"
  | "image_pair"
  | "image_group"
  | "ending";

export interface PlaybackStop {
  sectionId: string;
  type: ViewableSectionType;
  /** 1× 速度下的停留毫秒数（可配置确定性规则，不再请求模型）。 */
  dwellMs: number;
  chapterId: string | null;
  chapterTitle: string | null;
  label: string;
  /** 供引擎预加载当前+下一段图片。 */
  photoIds: string[];
  /** 内容可能超过一屏（大竖图/长文字）：引擎按 DOM 实测设置多个停靠点。 */
  tallHint: boolean;
}

export interface PlaybackRoute {
  stops: PlaybackStop[];
  /** 1× 下停留之和 + 转场之和，作为“预计时长”展示（估计值）。 */
  baseTotalMs: number;
}

export interface PlaybackPlanInput {
  sections: LayoutSectionT[];
  chapters: ChapterT[];
  photos: Record<string, { width: number; height: number } | undefined>;
  curatorialStatement?: string;
}

/** 停靠点之间的平缓转场基准时长（§19.8 章节之间保留呼吸感）。 */
export const PLAYBACK_TRANSITION_MS = 1400;

export const PLAYBACK_SPEEDS = [
  { id: "slow", label: "舒缓", factor: 0.75 },
  { id: "standard", label: "标准", factor: 1 },
  { id: "fast", label: "快速", factor: 1.5 },
] as const;

export type PlaybackSpeedId = (typeof PLAYBACK_SPEEDS)[number]["id"];

const TYPE_LABEL: Record<ViewableSectionType, string> = {
  hero: "首图",
  chapter_intro: "章节",
  statement: "策展语",
  single_image: "照片",
  image_pair: "双图",
  image_group: "图组",
  ending: "结尾",
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 文字量→停留：base 起步，每字 +perChar，封顶 max（§19.8 建议区间）。 */
function textDwell(text: string, base: number, perChar: number, max: number): number {
  return clamp(base + text.length * perChar, base, max);
}

function stopDwell(section: LayoutSectionT, input: PlaybackPlanInput): number {
  switch (section.type) {
    case "hero":
      return 5000;
    case "chapter_intro": {
      const ch = input.chapters.find((c) => c.id === section.chapter_id);
      return textDwell(`${ch?.title ?? ""}${ch?.description ?? ""}`, 3000, 25, 5000);
    }
    case "statement": {
      const text = section.text_override ?? input.curatorialStatement ?? "";
      return textDwell(text, 3000, 25, 5000);
    }
    case "single_image": {
      const dim = input.photos[section.photo_id];
      const ratio = dim && dim.width > 0 ? dim.height / dim.width : 2 / 3;
      // 竖幅越高停留越久（5–8s）；引擎另按实测高度设多停靠点。
      return Math.round(clamp(5000 + Math.max(0, ratio - 1) * 3000, 5000, 8000));
    }
    case "image_pair":
      return 7000;
    case "image_group":
      return clamp(7000 + (section.photo_ids.length - 2) * 1500, 7000, 10000);
    case "ending":
      return 5000;
    default:
      return 0;
  }
}

function tallHint(section: LayoutSectionT, input: PlaybackPlanInput): boolean {
  if (section.type === "single_image") {
    const dim = input.photos[section.photo_id];
    return !!dim && dim.width > 0 && dim.height / dim.width >= 1.5;
  }
  if (section.type === "chapter_intro") {
    const ch = input.chapters.find((c) => c.id === section.chapter_id);
    return `${ch?.title ?? ""}${ch?.description ?? ""}`.length >= 120;
  }
  if (section.type === "statement") {
    return (section.text_override ?? input.curatorialStatement ?? "").length >= 120;
  }
  return false;
}

function sectionPhotoIds(section: LayoutSectionT): string[] {
  switch (section.type) {
    case "hero":
    case "single_image":
      return [section.photo_id];
    case "image_pair":
    case "image_group":
    case "ending":
      return [...section.photo_ids];
    default:
      return [];
  }
}

export function buildPlaybackRoute(input: PlaybackPlanInput): PlaybackRoute {
  const chapterOf = (photoId: string | undefined): ChapterT | undefined =>
    photoId ? input.chapters.find((c) => c.photo_ids.includes(photoId)) : undefined;

  const stops: PlaybackStop[] = [];
  for (const section of input.sections) {
    if (section.type === "spacer") continue;
    const type = section.type as ViewableSectionType;
    const photoIds = sectionPhotoIds(section);
    let chapter: ChapterT | undefined;
    if (section.type === "chapter_intro" || section.type === "statement") {
      chapter = input.chapters.find((c) => c.id === section.chapter_id);
    } else if (section.type !== "hero") {
      // 首图是影展开场，先于任何章节；其余照片节点按章节成员归属。
      chapter = chapterOf(photoIds[0]);
    }
    stops.push({
      sectionId: section.id,
      type,
      dwellMs: stopDwell(section, input),
      chapterId: chapter?.id ?? null,
      chapterTitle: chapter?.title ?? null,
      label: TYPE_LABEL[type],
      photoIds,
      tallHint: tallHint(section, input),
    });
  }

  const dwellSum = stops.reduce((a, s) => a + s.dwellMs, 0);
  const transitions = Math.max(0, stops.length - 1) * PLAYBACK_TRANSITION_MS;
  return { stops, baseTotalMs: dwellSum + transitions };
}

/** 速度同时作用于停留与转场，保持语义一致（§19.8）。 */
export function estimateTotalMs(route: PlaybackRoute, factor: number): number {
  if (route.stops.length === 0 || factor <= 0) return 0;
  return Math.round(route.baseTotalMs / factor);
}
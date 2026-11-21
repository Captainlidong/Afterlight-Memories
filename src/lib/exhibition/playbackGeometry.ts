import { PLAYBACK_TRANSITION_MS, type PlaybackRoute } from "./playbackPlan";

/**
 * 放映几何（§19.8/§19.9）：把路线按实测 DOM 展开为停靠点。
 * 超过一屏的竖幅图/长文字设多个停靠点（重叠步长，缓慢经过有效区域，不只露顶部）；
 * 目标位置扣除固定导航遮挡并钳制在可滚动范围。纯函数，便于单测与导出脚本复用同一规则。
 */

export interface SectionMeasure {
  top: number;
  height: number;
}

export interface ExpandedStop {
  key: string;
  sectionId: string;
  stopIndex: number;
  subIndex: number;
  subCount: number;
  targetY: number;
  dwellMs: number;
  photoIds: string[];
}

export interface ExpandOpts {
  viewportH: number;
  /** 固定导航/控制栏遮挡：目标位置 = section 顶部 - navOffset。 */
  navOffset: number;
  maxScrollY: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 拆分停留时间，余数补给前几个停靠点，保证总和不变。 */
function splitDwell(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const rem = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < rem ? 1 : 0));
}

export function expandRoute(route: PlaybackRoute, measures: Record<string, SectionMeasure>, opts: ExpandOpts): ExpandedStop[] {
  const viewH = Math.max(200, opts.viewportH - opts.navOffset);
  const step = viewH * 0.7;
  const out: ExpandedStop[] = [];

  route.stops.forEach((stop, stopIndex) => {
    const m = measures[stop.sectionId] ?? { top: 0, height: viewH };
    const base = clamp(m.top - opts.navOffset, 0, opts.maxScrollY);
    const overflow = m.height - viewH;
    const docks = overflow > viewH * 0.05 ? 1 + Math.ceil(overflow / step) : 1;
    const targets: number[] = [];
    for (let i = 0; i < docks; i++) {
      const raw = docks === 1 ? base : base + Math.round((i * overflow) / (docks - 1));
      const y = clamp(raw, 0, opts.maxScrollY);
      if (targets.length === 0 || targets[targets.length - 1] !== y) targets.push(y);
    }
    // 钳制去重后均分停留（总和不变）
    const finalDwells = splitDwell(stop.dwellMs, targets.length);
    targets.forEach((targetY, subIndex) => {
      out.push({
        key: `${stop.sectionId}#${subIndex}`,
        sectionId: stop.sectionId,
        stopIndex,
        subIndex,
        subCount: targets.length,
        targetY,
        dwellMs: finalDwells[subIndex],
        photoIds: stop.photoIds,
      });
    });
  });

  return out;
}

/** 用户接管后按最近可观看节点重新定位（不重回首图）。 */
export function nearestExpandedIndex(expanded: ExpandedStop[], scrollY: number): number {
  if (expanded.length === 0) return 0;
  let best = 0;
  let bestDist = Infinity;
  expanded.forEach((e, i) => {
    const d = Math.abs(e.targetY - scrollY);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

/**
 * 进度按播放路线与停留进度计算（不是 scrollY/scrollHeight，章节停留不算卡住）。
 * 权重 = 停留 + 转场；速度对分子分母同比例作用，故无需传入倍率。
 */
export function computeProgress(expanded: ExpandedStop[], index: number, elapsedMs: number): number {
  const n = expanded.length;
  if (n === 0) return 0;
  const total = expanded.reduce((a, e) => a + e.dwellMs, 0) + (n - 1) * PLAYBACK_TRANSITION_MS;
  if (total <= 0) return 0;
  const i = clamp(index, 0, n - 1);
  let done = 0;
  for (let k = 0; k < i; k++) done += expanded[k].dwellMs + PLAYBACK_TRANSITION_MS;
  done += clamp(elapsedMs, 0, expanded[i].dwellMs);
  return clamp(done / total, 0, 1);
}
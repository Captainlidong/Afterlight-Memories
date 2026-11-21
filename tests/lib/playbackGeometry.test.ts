import { describe, expect, test } from "vitest";
import {
  computeProgress,
  expandRoute,
  nearestExpandedIndex,
} from "@/lib/exhibition/playbackGeometry";
import { PLAYBACK_TRANSITION_MS, type PlaybackRoute } from "@/lib/exhibition/playbackPlan";

function route(stops: { sectionId: string; dwellMs: number; tallHint?: boolean }[]): PlaybackRoute {
  const baseTotalMs = stops.reduce((a, s) => a + s.dwellMs, 0) + Math.max(0, stops.length - 1) * PLAYBACK_TRANSITION_MS;
  return {
    stops: stops.map((s, i) => ({
      sectionId: s.sectionId,
      type: "single_image",
      dwellMs: s.dwellMs,
      chapterId: null,
      chapterTitle: null,
      label: "照片",
      photoIds: [`p${i}`],
      tallHint: s.tallHint ?? false,
    })),
    baseTotalMs,
  };
}

const opts = { viewportH: 900, navOffset: 100, maxScrollY: 5000 };

describe("expandRoute 停靠点展开", () => {
  test("一屏内的 section 单停靠点，目标位置扣除顶部导航遮挡", () => {
    const r = route([{ sectionId: "a", dwellMs: 5000 }, { sectionId: "b", dwellMs: 5000 }]);
    const expanded = expandRoute(r, { a: { top: 0, height: 800 }, b: { top: 1200, height: 600 } }, opts);
    expect(expanded).toHaveLength(2);
    expect(expanded[0].targetY).toBe(0);
    expect(expanded[1].targetY).toBe(1100);
    expect(expanded[0].subCount).toBe(1);
    expect(expanded[1].dwellMs).toBe(5000);
  });

  test("超过一屏的竖幅/长文字设多个停靠点，缓慢经过有效区域（有重叠、不跳顶）", () => {
    const r = route([{ sectionId: "tall", dwellMs: 8000, tallHint: true }]);
    const expanded = expandRoute(r, { tall: { top: 1000, height: 3000 } }, opts);
    expect(expanded.length).toBeGreaterThan(1);
    expect(expanded.every((e) => e.sectionId === "tall")).toBe(true);
    expect(expanded[0].targetY).toBe(900);
    // 相邻停靠点步长小于一屏（保留重叠，内容连续可读）
    for (let i = 1; i < expanded.length; i++) {
      const step = expanded[i].targetY - expanded[i - 1].targetY;
      expect(step).toBeGreaterThan(0);
      expect(step).toBeLessThan(opts.viewportH - opts.navOffset);
    }
    // 最后一个停靠点能看到内容底部（视口底边 = targetY + viewportH）
    const last = expanded[expanded.length - 1];
    expect(last.targetY + opts.viewportH).toBeGreaterThanOrEqual(1000 + 3000 - 1);
    // 停留时间拆分后总和不变（预计时长不因多停靠点膨胀）
    expect(expanded.reduce((a, e) => a + e.dwellMs, 0)).toBe(8000);
  });

  test("目标位置钳制在 [0, maxScrollY]，重复钳制值去重", () => {
    const r = route([{ sectionId: "end", dwellMs: 5000 }]);
    const expanded = expandRoute(r, { end: { top: 4800, height: 2000 } }, { ...opts, maxScrollY: 5000 });
    expect(expanded.every((e) => e.targetY <= 5000)).toBe(true);
    expect(expanded[expanded.length - 1].targetY).toBe(5000);
    const ys = expanded.map((e) => e.targetY);
    expect(new Set(ys).size).toBe(ys.length);
  });

  test("缺失测量时兜底单停靠点，不崩溃", () => {
    const r = route([{ sectionId: "missing", dwellMs: 5000 }]);
    const expanded = expandRoute(r, {}, opts);
    expect(expanded).toHaveLength(1);
    expect(expanded[0].dwellMs).toBe(5000);
  });

  test("空路线 → 空展开", () => {
    expect(expandRoute(route([]), {}, opts)).toEqual([]);
  });
});

describe("nearestExpandedIndex 接管后按最近节点定位", () => {
  const r = route([{ sectionId: "a", dwellMs: 5000 }, { sectionId: "b", dwellMs: 5000 }, { sectionId: "c", dwellMs: 5000 }]);
  const expanded = expandRoute(r, { a: { top: 0, height: 800 }, b: { top: 1200, height: 600 }, c: { top: 2400, height: 600 } }, opts);

  test("取与当前滚动位置最近的停靠点", () => {
    expect(nearestExpandedIndex(expanded, 0)).toBe(0);
    expect(nearestExpandedIndex(expanded, 1150)).toBe(1);
    expect(nearestExpandedIndex(expanded, 4000)).toBe(2);
  });

  test("空展开返回 0", () => {
    expect(nearestExpandedIndex([], 123)).toBe(0);
  });
});

describe("computeProgress 按路线与停留进度计算", () => {
  const r = route([{ sectionId: "a", dwellMs: 6000 }, { sectionId: "b", dwellMs: 4000 }]);
  const expanded = expandRoute(r, { a: { top: 0, height: 800 }, b: { top: 1200, height: 600 } }, opts);

  test("起点 0，终点 1，停留中单调增长（不把章节停留当卡住）", () => {
    expect(computeProgress(expanded, 0, 0)).toBe(0);
    const mid = computeProgress(expanded, 0, 3000);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(computeProgress(expanded, 0, 6000));
    expect(computeProgress(expanded, 1, 4000)).toBe(1);
  });

  test("第二段起点 = 第一段停留+转场占比", () => {
    const total = 6000 + 4000 + PLAYBACK_TRANSITION_MS;
    expect(computeProgress(expanded, 1, 0)).toBeCloseTo((6000 + PLAYBACK_TRANSITION_MS) / total, 5);
  });

  test("elapsed 超界钳制；空展开进度 0（不除零）", () => {
    expect(computeProgress(expanded, 0, 999999)).toBeLessThanOrEqual(1);
    expect(computeProgress([], 0, 0)).toBe(0);
  });
});
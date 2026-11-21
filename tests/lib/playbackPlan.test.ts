import { describe, expect, test } from "vitest";
import {
  PLAYBACK_SPEEDS,
  PLAYBACK_TRANSITION_MS,
  buildPlaybackRoute,
  estimateTotalMs,
  type PlaybackPlanInput,
} from "@/lib/exhibition/playbackPlan";
import type { ChapterT, LayoutSectionT } from "@/lib/agents/schemas";

function chapter(id: string, title: string, photoIds: string[], description = "一段短文。"): ChapterT {
  return { id, title, description, photo_ids: photoIds, placement_reasons: [], locked: false };
}

const photos: PlaybackPlanInput["photos"] = {
  p1: { width: 1600, height: 1067 },
  p2: { width: 1067, height: 1600 },
  p3: { width: 1600, height: 1067 },
  p4: { width: 1600, height: 1067 },
  tall: { width: 900, height: 2400 },
};

function sections(): LayoutSectionT[] {
  return [
    { id: "s-hero", type: "hero", photo_id: "p1", height: "92vh", caption_position: "bottom-left" },
    { id: "s-spacer-1", type: "spacer", size: "large" },
    { id: "s-ch1", type: "chapter_intro", chapter_id: "c1", spacing: "large" },
    { id: "s-single", type: "single_image", photo_id: "p2", size: "large", spacing: "medium" },
    { id: "s-pair", type: "image_pair", photo_ids: ["p3", "p4"], ratio: "60-40", gap: "medium" },
    { id: "s-group", type: "image_group", photo_ids: ["p1", "p3", "p4"], gap: "small" },
    { id: "s-stmt", type: "statement", chapter_id: "c1" },
    { id: "s-spacer-2", type: "spacer", size: "small" },
    { id: "s-end", type: "ending", photo_ids: ["p4"] },
  ];
}

function input(overrides: Partial<PlaybackPlanInput> = {}): PlaybackPlanInput {
  return {
    sections: sections(),
    chapters: [chapter("c1", "窗与背影", ["p1", "p2", "p3"]), chapter("c2", "冷光", ["p4"])],
    photos,
    ...overrides,
  };
}

describe("buildPlaybackRoute 停靠点", () => {
  test("spacer 不作为停靠点，可观看节点按布局顺序保留", () => {
    const route = buildPlaybackRoute(input());
    expect(route.stops.map((s) => s.sectionId)).toEqual([
      "s-hero", "s-ch1", "s-single", "s-pair", "s-group", "s-stmt", "s-end",
    ]);
    expect(route.stops.every((s) => s.type !== "spacer" as string)).toBe(true);
  });

  test("空布局 → 空路线，总时长 0（不除零）", () => {
    const route = buildPlaybackRoute(input({ sections: [] }));
    expect(route.stops).toEqual([]);
    expect(route.baseTotalMs).toBe(0);
    expect(estimateTotalMs(route, 1)).toBe(0);
  });

  test("首图停留 4–6 秒", () => {
    const stop = buildPlaybackRoute(input()).stops.find((s) => s.type === "hero")!;
    expect(stop.dwellMs).toBeGreaterThanOrEqual(4000);
    expect(stop.dwellMs).toBeLessThanOrEqual(6000);
  });

  test("章节标题停留 3–5 秒，文字越多停留越久", () => {
    const short = buildPlaybackRoute(input());
    const long = buildPlaybackRoute(input({
      chapters: [chapter("c1", "窗与背影", ["p1", "p2", "p3"], "这是一段明显更长的章节描述，用来验证文字量会适度增加停留时间，但仍然保持在建议区间之内。"), chapter("c2", "冷光", ["p4"])],
    }));
    const a = short.stops.find((s) => s.sectionId === "s-ch1")!;
    const b = long.stops.find((s) => s.sectionId === "s-ch1")!;
    expect(a.dwellMs).toBeGreaterThanOrEqual(3000);
    expect(b.dwellMs).toBeLessThanOrEqual(5000);
    expect(b.dwellMs).toBeGreaterThan(a.dwellMs);
  });

  test("单张照片停留 5–8 秒，竖幅比横幅停留更久", () => {
    const route = buildPlaybackRoute(input());
    const portrait = route.stops.find((s) => s.sectionId === "s-single")!;
    expect(portrait.dwellMs).toBeGreaterThanOrEqual(5000);
    expect(portrait.dwellMs).toBeLessThanOrEqual(8000);
    const landscape = buildPlaybackRoute(input({
      sections: [{ id: "s-land", type: "single_image", photo_id: "p1", size: "large", spacing: "medium" }],
    })).stops[0];
    expect(portrait.dwellMs).toBeGreaterThan(landscape.dwellMs);
  });

  test("双图/图组停留 7–10 秒，图组张数越多停留越久", () => {
    const route = buildPlaybackRoute(input());
    const pair = route.stops.find((s) => s.type === "image_pair")!;
    const group = route.stops.find((s) => s.type === "image_group")!;
    expect(pair.dwellMs).toBeGreaterThanOrEqual(7000);
    expect(pair.dwellMs).toBeLessThanOrEqual(10000);
    expect(group.dwellMs).toBeGreaterThan(pair.dwellMs);
    expect(group.dwellMs).toBeLessThanOrEqual(10000);
  });

  test("结尾固定停留约 5 秒", () => {
    const stop = buildPlaybackRoute(input()).stops.find((s) => s.type === "ending")!;
    expect(stop.dwellMs).toBe(5000);
  });

  test("策展语按文字量停留 3–5 秒", () => {
    const stop = buildPlaybackRoute(input()).stops.find((s) => s.type === "statement")!;
    expect(stop.dwellMs).toBeGreaterThanOrEqual(3000);
    expect(stop.dwellMs).toBeLessThanOrEqual(5000);
  });
});

describe("buildPlaybackRoute 章节与预加载信息", () => {
  test("chapter_intro 携带所属章节；照片节点按章节成员归属", () => {
    const route = buildPlaybackRoute(input());
    const ch1 = route.stops.find((s) => s.sectionId === "s-ch1")!;
    expect(ch1.chapterId).toBe("c1");
    expect(ch1.chapterTitle).toBe("窗与背影");
    const single = route.stops.find((s) => s.sectionId === "s-single")!;
    expect(single.chapterId).toBe("c1");
    const end = route.stops.find((s) => s.sectionId === "s-end")!;
    expect(end.chapterId).toBe("c2");
    const hero = route.stops.find((s) => s.type === "hero")!;
    expect(hero.chapterId).toBeNull();
  });

  test("每个停靠点收集 photoIds 供预加载（当前+下一段）", () => {
    const route = buildPlaybackRoute(input());
    expect(route.stops.find((s) => s.sectionId === "s-pair")!.photoIds).toEqual(["p3", "p4"]);
    expect(route.stops.find((s) => s.sectionId === "s-single")!.photoIds).toEqual(["p2"]);
    expect(route.stops.find((s) => s.type === "chapter_intro")!.photoIds).toEqual([]);
  });

  test("大竖图与长文字标记 tallHint（引擎据此设多停靠点）", () => {
    const route = buildPlaybackRoute(input({
      sections: [
        { id: "s-tall", type: "single_image", photo_id: "tall", size: "large", spacing: "medium" },
        { id: "s-long", type: "chapter_intro", chapter_id: "c1", spacing: "large" },
      ],
      chapters: [chapter("c1", "窗与背影", ["p1"], "长".repeat(160)), chapter("c2", "冷光", ["p4"])],
    }));
    expect(route.stops.find((s) => s.sectionId === "s-tall")!.tallHint).toBe(true);
    expect(route.stops.find((s) => s.sectionId === "s-long")!.tallHint).toBe(true);
    const normal = buildPlaybackRoute(input());
    expect(normal.stops.find((s) => s.sectionId === "s-single")!.tallHint).toBe(false);
  });

  test("照片尺寸缺失时不崩溃，按默认比例处理", () => {
    const route = buildPlaybackRoute(input({ photos: {} }));
    const single = route.stops.find((s) => s.sectionId === "s-single")!;
    expect(single.dwellMs).toBeGreaterThanOrEqual(5000);
    expect(single.dwellMs).toBeLessThanOrEqual(8000);
  });

  test("确定性：相同输入产生相同路线", () => {
    expect(buildPlaybackRoute(input())).toEqual(buildPlaybackRoute(input()));
  });
});

describe("速度与总时长估计", () => {
  test("速度档位为 舒缓 0.75× / 标准 1× / 快速 1.5×", () => {
    expect(PLAYBACK_SPEEDS.map((s) => [s.label, s.factor])).toEqual([
      ["舒缓", 0.75], ["标准", 1], ["快速", 1.5],
    ]);
  });

  test("总时长 = 停留之和 + 停靠点之间的转场；标为估计", () => {
    const route = buildPlaybackRoute(input());
    const dwellSum = route.stops.reduce((a, s) => a + s.dwellMs, 0);
    expect(route.baseTotalMs).toBe(dwellSum + (route.stops.length - 1) * PLAYBACK_TRANSITION_MS);
    expect(estimateTotalMs(route, 1)).toBe(route.baseTotalMs);
  });

  test("速度同时作用于停留与转场：快速更短、舒缓更长", () => {
    const route = buildPlaybackRoute(input());
    const fast = estimateTotalMs(route, 1.5);
    const slow = estimateTotalMs(route, 0.75);
    expect(fast).toBeLessThan(route.baseTotalMs);
    expect(slow).toBeGreaterThan(route.baseTotalMs);
    expect(fast).toBe(Math.round(route.baseTotalMs / 1.5));
    expect(slow).toBe(Math.round(route.baseTotalMs / 0.75));
  });
});
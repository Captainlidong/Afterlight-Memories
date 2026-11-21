import { describe, it, expect } from "vitest";
import { AestheticPrefs } from "@/lib/agents/schemas";
import { heuristicCurate } from "@/lib/adapters/demoCurationAdapter";
import type { CurationPhotoInput } from "@/lib/adapters/types";

const prefs = AestheticPrefs.parse({});

function photo(over: Partial<CurationPhotoInput> & { photoId: string }): CurationPhotoInput {
  return {
    sha256: over.photoId,
    sharpness_score: 0.7,
    brightness_score: 0.5,
    highlight_clip_ratio: 0.02,
    shadow_clip_ratio: 0.05,
    color_temp: 0,
    saturation: 0.35,
    subjects: [],
    composition_tags: ["框景"],
    duplicate_group_id: null,
    ...over,
  };
}

function decisionOf(out: ReturnType<typeof heuristicCurate>, id: string) {
  return out.find((d) => d.photo_id === id)!;
}

describe("启发式筛选 — 重复组处理", () => {
  it("同组两张都清晰 → 最佳 keep，其余 hold，绝不自动 remove", () => {
    const out = heuristicCurate(
      [
        photo({ photoId: "a", sharpness_score: 0.8, duplicate_group_id: "g1" }),
        photo({ photoId: "b", sharpness_score: 0.75, duplicate_group_id: "g1" }),
      ],
      prefs,
    );
    expect(decisionOf(out, "a").decision).toBe("keep");
    expect(decisionOf(out, "b").decision).toBe("hold");
    expect(out.every((d) => d.decision !== "remove")).toBe(true);
    expect(decisionOf(out, "b").related_photo_ids).toContain("a");
  });

  it("同组一张严重模糊且明显劣于更清晰孪生 → 该张 remove，清晰张 keep", () => {
    const out = heuristicCurate(
      [
        photo({ photoId: "a", sharpness_score: 0.9, duplicate_group_id: "g2" }),
        photo({ photoId: "b", sharpness_score: 0.1, duplicate_group_id: "g2" }),
      ],
      prefs,
    );
    expect(decisionOf(out, "a").decision).toBe("keep");
    expect(decisionOf(out, "b").decision).toBe("remove");
  });
});

describe("启发式筛选 — 低清晰度但独特", () => {
  it("独特照片清晰度偏低 → hold（不是 remove）", () => {
    const out = heuristicCurate(
      [photo({ photoId: "a", sharpness_score: 0.15, composition_tags: ["背影"] })],
      prefs,
    );
    expect(decisionOf(out, "a").decision).toBe("hold");
  });

  it("高光溢出较多 → hold，理由提及可能过曝", () => {
    const out = heuristicCurate(
      [photo({ photoId: "a", sharpness_score: 0.7, highlight_clip_ratio: 0.4 })],
      prefs,
    );
    const d = decisionOf(out, "a");
    expect(d.decision).toBe("hold");
    expect(d.reasons.join("")).toMatch(/过曝|高光/);
  });

  it("技术良好且构图独特的单张 → keep", () => {
    const out = heuristicCurate(
      [photo({ photoId: "a", sharpness_score: 0.85, composition_tags: ["框景", "引导线"] })],
      prefs,
    );
    expect(decisionOf(out, "a").decision).toBe("keep");
  });
});

describe("启发式筛选 — 理由与契约", () => {
  it("每张照片至少一条人能读懂的理由", () => {
    const out = heuristicCurate(
      [
        photo({ photoId: "a", sharpness_score: 0.85 }),
        photo({ photoId: "b", sharpness_score: 0.15 }),
        photo({ photoId: "c", sharpness_score: 0.1, duplicate_group_id: "g", }),
        photo({ photoId: "d", sharpness_score: 0.9, duplicate_group_id: "g" }),
      ],
      prefs,
    );
    expect(out.length).toBe(4);
    expect(out.every((d) => d.reasons.length >= 1 && d.reasons.every((r) => r.length > 0))).toBe(true);
    expect(out.every((d) => d.score >= 0 && d.score <= 1)).toBe(true);
    expect(out.every((d) => d.confidence >= 0 && d.confidence <= 1)).toBe(true);
  });

  it("偏好 focus=light 提升冷调光线照片的评分（偏好影响筛选而非只改颜色）", () => {
    const p = photo({ photoId: "a", sharpness_score: 0.6, composition_tags: ["冷调"] });
    const base = heuristicCurate([p], AestheticPrefs.parse({ focus: [] }));
    const focused = heuristicCurate([p], AestheticPrefs.parse({ focus: ["light"] }));
    expect(decisionOf(focused, "a").score).toBeGreaterThan(decisionOf(base, "a").score);
  });
});
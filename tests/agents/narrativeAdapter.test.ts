import { describe, it, expect } from "vitest";
import manifest from "@/lib/demo/data/manifest.json";
import { NarrativePlan, type ToneT } from "@/lib/agents/schemas";
import { demoNarrativeAdapter, heuristicNarrative } from "@/lib/adapters/demoNarrativeAdapter";
import { getNarrativeAdapter } from "@/lib/adapters";
import { demoInspection } from "@/lib/demo/manifest";
import { checkNarrativeCredibility } from "@/lib/agents/credibility";
import { assertNarrativeStructure } from "@/lib/orchestrator/merge";
import type { NarrativeInput, NarrativePhotoInput } from "@/lib/adapters/types";

const shaByIndex = new Map<number, string>();
for (const [sha, idx] of Object.entries(manifest as Record<string, number>)) {
  shaByIndex.set(idx, sha);
}
const KEEP = [1, 2, 3, 4, 6, 7, 8, 9, 11, 12, 15, 16, 17, 18, 19, 20, 24];

function demoInput(tone: ToneT = "restrained"): NarrativeInput {
  const photos: NarrativePhotoInput[] = KEEP.map((index) => {
    const preset = demoInspection(index)!;
    return {
      photoId: `photo_${index}`,
      sha256: shaByIndex.get(index)!,
      subjects: preset.subjects,
      composition_tags: preset.composition_tags,
      color_temp: null,
      saturation: null,
      brightness_score: 0.5,
      sharpness_score: 0.7,
      duplicate_group_id: null,
      sort_order: index,
    };
  });
  return {
    motif: {
      motifId: "motif_x",
      title: "人物与空间之间的距离",
      description: "大留白与纵深让人物显得很小。",
      photo_ids: ["photo_4", "photo_7", "photo_9", "photo_12", "photo_24"],
      evidence: ["4 张保留照片使用留白或大留白构图"],
    },
    photos,
    mustKeepIds: [],
    tone,
    chapterCount: 3,
    userIntent: null,
    exhibitionTitle: "在光线转弯之前",
  };
}

const allPhotoIds = (plan: ReturnType<typeof NarrativePlan.parse>) =>
  plan.chapters.flatMap((c) => c.photo_ids);

describe("demoNarrativeAdapter — 预设命中（《在光线转弯之前》）", () => {
  it("omitted preset anchors resolve to actual chapter photos", async () => {
    const input = demoInput();
    input.photos = input.photos.filter(photo => !["photo_1", "photo_4", "photo_6", "photo_15", "photo_16", "photo_24"].includes(photo.photoId));
    input.motif.photo_ids = [input.photos[0].photoId];
    const plan = await demoNarrativeAdapter.compose(input);
    expect(() => assertNarrativeStructure(plan, { keepIds: input.photos.map(photo => photo.photoId), mustKeepIds: [], motifPhotoIds: input.motif.photo_ids })).not.toThrow();
    for (const chapter of plan.chapters) {
      expect(chapter.photo_ids).toContain(chapter.opening_photo_id);
      expect(chapter.photo_ids).toContain(chapter.closing_photo_id);
    }
  });
  it("17 张保留 → 三章，全部照片恰好出现一次，通过 NarrativePlan 校验", async () => {
    const plan = NarrativePlan.parse(await demoNarrativeAdapter.compose(demoInput()));
    expect(plan.title).toBe("在光线转弯之前");
    expect(plan.chapters.length).toBe(3);
    expect(plan.selected_motif_id).toBe("motif_x");
    const ids = allPhotoIds(plan);
    expect(ids.length).toBe(17);
    expect(new Set(ids).size).toBe(17);
    expect(ids.sort()).toEqual(KEEP.map((i) => `photo_${i}`).sort());
    expect(plan.chapters.map((c) => c.title)).toEqual(["进入", "经过", "留下"]);
  });

  it("预设叙事通过可信边界校验", async () => {
    const input = demoInput();
    const plan = await demoNarrativeAdapter.compose(input);
    const report = checkNarrativeCredibility(plan, {
      keepIds: input.photos.map((p) => p.photoId),
      motifPhotoIds: input.motif.photo_ids,
    });
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("四种语气产出不同策展语，但章节照片结构一致", async () => {
    const tones: ToneT[] = ["documentary", "restrained", "poetic", "direct"];
    const plans = await Promise.all(tones.map((t) => demoNarrativeAdapter.compose(demoInput(t))));
    const statements = new Set(plans.map((p) => p.curatorial_statement));
    expect(statements.size).toBe(4);
    const structure = plans.map((p) => p.chapters.map((c) => c.photo_ids.join(",")).join("|"));
    expect(new Set(structure).size).toBe(1);
    for (const p of plans) expect(NarrativePlan.safeParse(p).success).toBe(true);
  });

  it("开场/转折/结尾照片附放置理由", async () => {
    const plan = await demoNarrativeAdapter.compose(demoInput());
    const reasons = plan.chapters.flatMap((c) => c.placement_reasons);
    const roles = new Set(reasons.map((r) => r.role));
    expect(roles.has("opening")).toBe(true);
    expect(roles.has("turning")).toBe(true);
    expect(roles.has("closing")).toBe(true);
  });
});

const NP = (
  id: string,
  tags: string[],
  o: { brightness?: number; saturation?: number; sharpness?: number; order?: number } = {},
): NarrativePhotoInput => ({
  photoId: id,
  sha256: `sha_${id}`,
  subjects: [],
  composition_tags: tags,
  color_temp: null,
  saturation: o.saturation ?? 0.3,
  brightness_score: o.brightness ?? 0.5,
  sharpness_score: o.sharpness ?? 0.6,
  duplicate_group_id: null,
  sort_order: o.order ?? 0,
});

function heuristicInput(photos: NarrativePhotoInput[]): NarrativeInput {
  return {
    motif: { motifId: "m", title: "整组的观看线索", description: "空间先于主体。", photo_ids: photos.slice(0, 2).map((p) => p.photoId), evidence: ["证据"] },
    photos,
    mustKeepIds: [],
    tone: "restrained",
    chapterCount: 3,
    userIntent: null,
    exhibitionTitle: "我的影展",
  };
}

describe("heuristicNarrative — 自有照片兜底（§12.6 非分数排序）", () => {
  const photos = [
    NP("s1", ["大留白", "纵深", "框景"], { brightness: 0.4, saturation: 0.3, sharpness: 0.5, order: 1 }),
    NP("s2", ["框景", "窗"], { brightness: 0.45, sharpness: 0.6, order: 2 }),
    NP("p1", ["背影", "人物"], { brightness: 0.5, sharpness: 0.9, order: 3 }),
    NP("p2", ["背影", "小主体"], { brightness: 0.55, sharpness: 0.8, order: 4 }),
    NP("t1", ["几何", "明暗对比"], { brightness: 0.95, saturation: 0.4, sharpness: 0.7, order: 5 }),
    NP("q1", ["反光", "留白"], { brightness: 0.3, saturation: 0.1, sharpness: 0.6, order: 6 }),
    NP("q2", ["反光"], { brightness: 0.35, saturation: 0.15, sharpness: 0.5, order: 7 }),
  ];

  it("产出合法叙事，每章 ≥1 张、无跨章重复、全部照片入章", () => {
    const plan = NarrativePlan.parse(heuristicNarrative(heuristicInput(photos)));
    expect(plan.chapters.length).toBeGreaterThanOrEqual(2);
    expect(plan.chapters.length).toBeLessThanOrEqual(3);
    for (const c of plan.chapters) expect(c.photo_ids.length).toBeGreaterThanOrEqual(1);
    const ids = allPhotoIds(plan);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(photos.map((p) => p.photoId).sort());
  });

  it("开场=最空间感、结尾=最低饱和、转折=最亮，而非最高清晰度", () => {
    const plan = heuristicNarrative(heuristicInput(photos));
    expect(plan.chapters[0].opening_photo_id).toBe("s1");
    expect(plan.chapters[0].opening_photo_id).not.toBe("p1"); // p1 清晰度最高但不是开场
    expect(plan.chapters[plan.chapters.length - 1].closing_photo_id).toBe("q1");
    const turning = plan.chapters.flatMap((c) => c.placement_reasons).find((r) => r.role === "turning");
    expect(turning?.photo_id).toBe("t1");
  });

  it("启发式叙事通过可信边界校验", () => {
    const input = heuristicInput(photos);
    const plan = heuristicNarrative(input);
    const report = checkNarrativeCredibility(plan, {
      keepIds: photos.map((p) => p.photoId),
      motifPhotoIds: input.motif.photo_ids,
    });
    expect(report.ok).toBe(true);
  });

  it("仅 2 张照片 → 2 章，不死路", () => {
    const plan = NarrativePlan.parse(heuristicNarrative(heuristicInput([NP("a", ["框景"]), NP("b", ["反光"], { saturation: 0.1 })])));
    expect(plan.chapters.length).toBe(2);
    for (const c of plan.chapters) expect(c.photo_ids.length).toBeGreaterThanOrEqual(1);
  });
});

describe("getNarrativeAdapter — 模式路由", () => {
  it("ai 模式缺少服务端上下文时拒绝创建，不回退 Demo", () => {
    expect(() => getNarrativeAdapter("ai")).toThrow("服务端数据库与工作流上下文");
  });

  it("demo 模式返回预设标题", async () => {
    const plan = await getNarrativeAdapter("demo").compose(demoInput());
    expect(plan.title).toBe("在光线转弯之前");
  });
});

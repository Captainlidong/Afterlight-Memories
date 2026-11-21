import { describe, it, expect } from "vitest";
import { designLayout, type DesignerInput } from "@/lib/agents/exhibitionDesigner";
import { ExhibitionLayout, type NarrativePlanT, type LayoutSectionT } from "@/lib/agents/schemas";

function photo(photoId: string, subjects: string[], dup: string | null = null, color_temp: number | null = 6000) {
  return { photoId, subjects, composition_tags: [] as string[], color_temp, duplicate_group_id: dup };
}

function plan(): NarrativePlanT {
  return {
    title: "在光线转弯之前",
    subtitle: " subtitle",
    curatorial_statement: "窗与光线反复出现。",
    tone: "restrained",
    chapters: [
      { id: "chapter_01", title: "进入", description: "空间先出现。", photo_ids: ["p1", "p2", "p3", "p4"], opening_photo_id: "p1", closing_photo_id: "p4", locked: false, placement_reasons: [{ photo_id: "p1", role: "opening", reason: "框景晨光。" }] },
      { id: "chapter_02", title: "经过", description: "人物经过。", photo_ids: ["p5", "p6", "p7", "p8"], opening_photo_id: "p5", closing_photo_id: "p8", locked: false, placement_reasons: [{ photo_id: "p6", role: "turning", reason: "光束转折。" }] },
      { id: "chapter_03", title: "留下", description: "光线留下。", photo_ids: ["p9", "p10"], opening_photo_id: "p9", closing_photo_id: "p10", locked: false, placement_reasons: [] },
    ],
  };
}

function input(overrides: Partial<DesignerInput> = {}): DesignerInput {
  return {
    plan: plan(),
    template: "cinema_scroll",
    photos: [
      photo("p1", ["窗"]), photo("p2", ["窗"]), photo("p3", ["窗"]), photo("p4", ["拱门"]),
      photo("p5", ["背影", "走廊"]), photo("p6", ["光束"]), photo("p7", ["反光"]), photo("p8", ["倒影"]),
      photo("p9", ["空椅"]), photo("p10", ["广场"]),
    ],
    ...overrides,
  };
}

function allPhotoIds(sections: LayoutSectionT[]): string[] {
  const ids: string[] = [];
  for (const s of sections) {
    if (s.type === "hero" || s.type === "single_image") ids.push(s.photo_id);
    else if (s.type === "image_pair" || s.type === "image_group" || s.type === "ending") ids.push(...s.photo_ids);
  }
  return ids;
}

describe("exhibitionDesigner 规则引擎（§6.6 / §12.7）", () => {
  it("输出通过 ExhibitionLayout 校验，且只有一个 hero（首章开场）", () => {
    const layout = designLayout(input());
    expect(() => ExhibitionLayout.parse(layout)).not.toThrow();
    const heroes = layout.sections.filter((s) => s.type === "hero");
    expect(heroes).toHaveLength(1);
    expect(heroes[0].type === "hero" && heroes[0].photo_id).toBe("p1");
  });

  it("每章一个 chapter_intro", () => {
    const layout = designLayout(input());
    const intros = layout.sections.filter((s) => s.type === "chapter_intro");
    expect(intros.map((s) => s.type === "chapter_intro" && s.chapter_id)).toEqual(["chapter_01", "chapter_02", "chapter_03"]);
  });

  it("转折照片 → single_image large + 相邻大留白 spacer", () => {
    const layout = designLayout(input());
    const idx = layout.sections.findIndex((s) => s.type === "single_image" && s.photo_id === "p6");
    expect(idx).toBeGreaterThan(-1);
    const single = layout.sections[idx];
    expect(single.type === "single_image" && single.size).toBe("large");
    const neighbor = layout.sections[idx - 1];
    expect(neighbor.type === "spacer" && neighbor.size).toBe("large");
  });

  it("连续相似照片成组（pair/group），不全是大图单张", () => {
    const layout = designLayout(input());
    const grouped = layout.sections.filter((s) => s.type === "image_pair" || s.type === "image_group");
    expect(grouped.length).toBeGreaterThan(0);
    const p2single = layout.sections.find((s) => s.type === "single_image" && s.photo_id === "p2");
    expect(p2single).toBeUndefined();
  });

  it("结尾 ending 含 1–2 张（末章收束照片）", () => {
    const layout = designLayout(input());
    const endings = layout.sections.filter((s) => s.type === "ending");
    expect(endings).toHaveLength(1);
    const e = endings[0];
    expect(e.type === "ending" && e.photo_ids.length).toBeGreaterThanOrEqual(1);
    expect(e.type === "ending" && e.photo_ids.length).toBeLessThanOrEqual(2);
    expect(e.type === "ending" && e.photo_ids).toContain("p10");
  });

  it("任何照片在所有 section 中只出现一次（无跨 section 重复）", () => {
    const layout = designLayout(input());
    const ids = allPhotoIds(layout.sections);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("引用的照片都在输入照片集合内", () => {
    const inp = input();
    const layout = designLayout(inp);
    const allowed = new Set(inp.photos.map((p) => p.photoId));
    for (const id of allPhotoIds(layout.sections)) expect(allowed.has(id)).toBe(true);
  });

  it("确定性：相同输入产出完全相同的 sections（稳定 id）", () => {
    const a = designLayout(input());
    const b = designLayout(input());
    expect(a.sections).toEqual(b.sections);
    const ids = a.sections.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("模板决定色板：cinema_scroll 深色 / archive_collage 浅色", () => {
    const dark = designLayout(input({ template: "cinema_scroll" }));
    const light = designLayout(input({ template: "archive_collage" }));
    expect(dark.background).toBe("#101114");
    expect(dark.text_color).toBe("#f5f1e8");
    expect(light.background).toBe("#f5f1e8");
    expect(light.text_color).toBe("#101114");
  });

  it("语气影响章节间距：poetic 长留白 / direct 短间距", () => {
    const poetic = designLayout(input({ plan: { ...plan(), tone: "poetic" } }));
    const direct = designLayout(input({ plan: { ...plan(), tone: "direct" } }));
    const introOf = (l: ReturnType<typeof designLayout>) => l.sections.find((s) => s.type === "chapter_intro");
    const p = introOf(poetic);
    const d = introOf(direct);
    expect(p?.type === "chapter_intro" && p.spacing).toBe("large");
    expect(d?.type === "chapter_intro" && d.spacing).toBe("small");
  });
});
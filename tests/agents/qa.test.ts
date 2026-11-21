import { describe, it, expect } from "vitest";
import {
  QaReport,
  type ExhibitionLayoutT,
  type NarrativePlanT,
  type QaIssueT,
} from "@/lib/agents/schemas";
import { computeQa, applyQaFix, type QaPhoto } from "@/lib/agents/curatorialQa";

const photo = (id: string, over: Partial<QaPhoto> = {}): QaPhoto => ({
  id,
  status: "inspected",
  width: 1600,
  height: 1000,
  subjects: ["space"],
  duplicate_group_id: null,
  ...over,
});

const PHOTOS: QaPhoto[] = [photo("p1"), photo("p2"), photo("p3"), photo("p4")];

const narrative: NarrativePlanT = {
  title: "在光线转弯之前",
  subtitle: "",
  curatorial_statement: "窗与光线反复出现，像是在记录经过。",
  tone: "restrained",
  chapters: [
    { id: "ch1", title: "进入", description: "空间先于人出现。", photo_ids: ["p1", "p2"], placement_reasons: [], locked: false },
    { id: "ch2", title: "经过", description: "光线改变了墙面。", photo_ids: ["p3", "p4"], placement_reasons: [], locked: false },
  ],
};

const cleanLayout: ExhibitionLayoutT = {
  template: "cinema_scroll",
  background: "#101114",
  text_color: "#f5f1e8",
  sections: [
    { id: "hero", type: "hero", photo_id: "p1", height: "92vh", caption_position: "bottom-left" },
    { id: "i1", type: "chapter_intro", chapter_id: "ch1", spacing: "large" },
    { id: "s2", type: "single_image", photo_id: "p2", size: "medium", spacing: "medium" },
    { id: "i2", type: "chapter_intro", chapter_id: "ch2", spacing: "large" },
    { id: "s3", type: "single_image", photo_id: "p3", size: "large", spacing: "medium" },
    { id: "st", type: "statement" },
    { id: "end", type: "ending", photo_ids: ["p4"] },
  ],
};

const input = (over: Partial<Parameters<typeof computeQa>[0]> = {}) => ({
  layout: cleanLayout,
  narrative,
  photos: PHOTOS,
  keepIds: ["p1", "p2", "p3", "p4"],
  mustKeepIds: ["p4"],
  ...over,
});

const types = (issues: QaIssueT[]) => issues.map((i) => i.type);

describe("curatorialQa 规则引擎", () => {
  it("干净布局 → passed，仅 low 隐私提示，passed_checks 记录通过项", () => {
    const r = QaReport.parse(computeQa(input()));
    expect(r.status).toBe("passed");
    expect(types(r.issues)).toEqual(["privacy_hint"]);
    expect(r.issues[0].severity).toBe("low");
    expect(r.passed_checks).toContain("跨 section 无重复");
    expect(r.passed_checks).toContain("must_keep 全部在场");
  });

  it("跨 section 重复 → high repetition + 可自动修复", () => {
    const layout: ExhibitionLayoutT = {
      ...cleanLayout,
      sections: [
        ...cleanLayout.sections,
        { id: "dup", type: "single_image", photo_id: "p1", size: "medium", spacing: "medium" },
      ],
    };
    const r = computeQa(input({ layout }));
    const issue = r.issues.find((i) => i.type === "repetition")!;
    expect(issue.severity).toBe("high");
    expect(issue.photo_ids).toEqual(["p1"]);
    expect(issue.auto_fix_available).toBe(true);
    expect(r.status).toBe("needs_review");
  });

  it("applyQaFix 去重：后出现的引用被移除，pair 退化为 single", () => {
    const layout: ExhibitionLayoutT = {
      ...cleanLayout,
      sections: [
        cleanLayout.sections[0],
        { id: "dup", type: "single_image", photo_id: "p1", size: "medium", spacing: "medium" },
        { id: "pair", type: "image_pair", photo_ids: ["p2", "p1"], ratio: "60-40", gap: "medium" },
        cleanLayout.sections[6],
      ],
    };
    const issue = computeQa(input({ layout })).issues.find((i) => i.type === "repetition")!;
    const fixed = applyQaFix(layout, issue)!;
    const refs = fixed.sections.flatMap((s) =>
      s.type === "hero" || s.type === "single_image" ? [s.photo_id] : s.type === "image_pair" || s.type === "image_group" || s.type === "ending" ? s.photo_ids : [],
    );
    expect(new Set(refs).size).toBe(refs.length);
    expect(fixed.sections.find((s) => s.id === "pair")!.type).toBe("single_image");
    expect(fixed.sections.find((s) => s.id === "dup")).toBeUndefined();
  });

  it("≥3 相似连续满屏 → medium similar_run；2 张不报", () => {
    const runPhotos = [photo("p2", { duplicate_group_id: "g1" }), photo("p3", { duplicate_group_id: "g1" }), photo("p4", { duplicate_group_id: "g1" })];
    const mk = (n: number): ExhibitionLayoutT => ({
      ...cleanLayout,
      sections: [
        cleanLayout.sections[0],
        cleanLayout.sections[1],
        ...Array.from({ length: n }, (_, i) => ({
          id: `r${i}`,
          type: "single_image" as const,
          photo_id: `p${i + 2}`,
          size: "large" as const,
          spacing: "medium" as const,
        })),
        cleanLayout.sections[6],
      ],
    });
    const three = computeQa(input({ layout: mk(3), photos: runPhotos, keepIds: ["p1", "p2", "p3", "p4"], mustKeepIds: [] }));
    const issue = three.issues.find((i) => i.type === "similar_run")!;
    expect(issue.severity).toBe("medium");
    expect(issue.photo_ids).toEqual(["p2", "p3", "p4"]);
    const two = computeQa(input({ layout: mk(2), photos: runPhotos, keepIds: ["p1", "p2", "p3", "p4"], mustKeepIds: [] }));
    expect(two.issues.some((i) => i.type === "similar_run")).toBe(false);
  });

  it("applyQaFix 把相似连续 single 合并为 image_group", () => {
    const runPhotos = [photo("p2", { duplicate_group_id: "g1" }), photo("p3", { duplicate_group_id: "g1" }), photo("p4", { duplicate_group_id: "g1" })];
    const layout: ExhibitionLayoutT = {
      ...cleanLayout,
      sections: [
        cleanLayout.sections[0],
        cleanLayout.sections[1],
        { id: "r0", type: "single_image", photo_id: "p2", size: "large", spacing: "medium" },
        { id: "r1", type: "single_image", photo_id: "p3", size: "large", spacing: "medium" },
        { id: "r2", type: "single_image", photo_id: "p4", size: "large", spacing: "medium" },
        cleanLayout.sections[6],
      ],
    };
    const issue = computeQa(input({ layout, photos: runPhotos, mustKeepIds: [] })).issues.find((i) => i.type === "similar_run")!;
    const fixed = applyQaFix(layout, issue)!;
    const group = fixed.sections.find((s) => s.type === "image_group")!;
    expect(group.type === "image_group" && group.photo_ids).toEqual(["p2", "p3", "p4"]);
    expect(fixed.sections.filter((s) => s.id.startsWith("r")).length).toBe(1);
  });

  it("must_keep 不在布局 → high + 修复补入结尾前", () => {
    const r = computeQa(input({ mustKeepIds: ["p4", "p5"], photos: [...PHOTOS, photo("p5")], keepIds: ["p1", "p2", "p3", "p4", "p5"] }));
    const issue = r.issues.find((i) => i.type === "must_keep_missing")!;
    expect(issue.severity).toBe("high");
    expect(issue.photo_ids).toEqual(["p5"]);
    const fixed = applyQaFix(cleanLayout, issue)!;
    const idx = fixed.sections.findIndex((s) => s.type === "single_image" && s.photo_id === "p5");
    const endIdx = fixed.sections.findIndex((s) => s.type === "ending");
    expect(idx).toBeGreaterThan(-1);
    expect(idx).toBeLessThan(endIdx);
  });

  it("章节标题重复 → medium duplicate_title", () => {
    const dupNarrative: NarrativePlanT = {
      ...narrative,
      chapters: [narrative.chapters[0], { ...narrative.chapters[1], title: "进入" }],
    };
    const r = computeQa(input({ narrative: dupNarrative }));
    expect(r.issues.some((i) => i.type === "duplicate_title" && i.severity === "medium")).toBe(true);
  });

  it("结尾非 ending → medium abrupt_ending", () => {
    const layout: ExhibitionLayoutT = { ...cleanLayout, sections: cleanLayout.sections.slice(0, 6) };
    const r = computeQa(input({ layout, mustKeepIds: [] }));
    expect(r.issues.some((i) => i.type === "abrupt_ending")).toBe(true);
  });

  it("坏文件 → medium broken_file", () => {
    const r = computeQa(input({ photos: [...PHOTOS, photo("p6", { status: "failed" })] }));
    const issue = r.issues.find((i) => i.type === "broken_file")!;
    expect(issue.photo_ids).toEqual(["p6"]);
  });

  it("文案可信度复扫：禁断言 → high credibility", () => {
    const bad: NarrativePlanT = {
      ...narrative,
      chapters: [{ ...narrative.chapters[0], description: "他们分手之后，走廊只剩下一个人。" }, narrative.chapters[1]],
    };
    const r = computeQa(input({ narrative: bad }));
    const issue = r.issues.find((i) => i.type === "credibility")!;
    expect(issue.severity).toBe("high");
    expect(issue.chapter_id).toBe("ch1");
  });

  it("移动端溢出启发式：≥3 列组含竖图 → medium + 修复拆组", () => {
    const portrait = photo("p5", { width: 800, height: 1200 });
    const layout: ExhibitionLayoutT = {
      ...cleanLayout,
      sections: [
        ...cleanLayout.sections.slice(0, 4),
        { id: "g", type: "image_group", photo_ids: ["p2", "p3", "p5"], gap: "small" },
        cleanLayout.sections[6],
      ],
    };
    const photos = [...PHOTOS, portrait];
    const r = computeQa(input({ layout, photos, keepIds: ["p1", "p2", "p3", "p4", "p5"], mustKeepIds: [] }));
    const issue = r.issues.find((i) => i.type === "mobile_overflow")!;
    expect(issue.severity).toBe("medium");
    const fixed = applyQaFix(layout, issue)!;
    const groups = fixed.sections.filter((s) => s.type === "image_group");
    expect(groups.every((g) => g.type === "image_group" && g.photo_ids.length <= 2)).toBe(true);
  });

  it("章节内 ≥3 张同尺寸无起伏 → low chapter_rhythm", () => {
    const layout: ExhibitionLayoutT = {
      ...cleanLayout,
      sections: [
        cleanLayout.sections[0],
        cleanLayout.sections[1],
        { id: "a", type: "single_image", photo_id: "p2", size: "medium", spacing: "medium" },
        { id: "b", type: "single_image", photo_id: "p3", size: "medium", spacing: "medium" },
        { id: "c", type: "single_image", photo_id: "p4", size: "medium", spacing: "medium" },
        cleanLayout.sections[6],
      ],
    };
    const r = computeQa(input({ layout, mustKeepIds: [] }));
    const issue = r.issues.find((i) => i.type === "chapter_rhythm")!;
    expect(issue.severity).toBe("low");
    expect(issue.chapter_id).toBe("ch1");
  });
});
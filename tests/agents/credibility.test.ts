import { describe, it, expect } from "vitest";
import { checkNarrativeCredibility } from "@/lib/agents/credibility";
import type { NarrativePlanT, ChapterT } from "@/lib/agents/schemas";

function chapter(id: string, title: string, description: string, photo_ids: string[]): ChapterT {
  return { id, title, description, photo_ids, placement_reasons: [], locked: false };
}

const basePlan: NarrativePlanT = {
  title: "在光线转弯之前",
  subtitle: "一组关于窗、背影与经过的照片",
  curatorial_statement: "窗与光线反复出现，像是在记录经过而非停留。",
  chapters: [
    chapter("chapter_01", "进入", "先让空间出现。", ["p1", "p2"]),
    chapter("chapter_02", "经过", "人物更接近。", ["p3"]),
    chapter("chapter_03", "留下", "光线保留观看方向。", ["p4"]),
  ],
  tone: "restrained",
};
const keepIds = ["p1", "p2", "p3", "p4"];
const motifPhotoIds = ["p1", "p3"];

const rules = (plan: NarrativePlanT, ctx = { keepIds, motifPhotoIds }) =>
  checkNarrativeCredibility(plan, ctx).violations.map((v) => v.rule);

describe("credibility — 可信边界校验器（§13.3 / 提示词5 / §17.3）", () => {
  it("干净叙事 → ok=true，无违规", () => {
    const r = checkNarrativeCredibility(basePlan, { keepIds, motifPhotoIds });
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("私人关系断言（分手）被拒", () => {
    const plan = { ...basePlan, curatorial_statement: "他们分手了，窗边只剩一个人。" };
    expect(rules(plan)).toContain("forbidden_assertion");
    expect(checkNarrativeCredibility(plan, { keepIds, motifPhotoIds }).ok).toBe(false);
  });

  it("心理诊断（抑郁）被拒", () => {
    const plan = {
      ...basePlan,
      chapters: [chapter("chapter_01", "进入", "他患有抑郁症。", ["p1", "p2"]), ...basePlan.chapters.slice(1)],
    };
    expect(rules(plan)).toContain("forbidden_assertion");
  });

  it("无保留表达的内心推测被拒；加「似乎」后放行", () => {
    const unhedged = { ...basePlan, curatorial_statement: "他感到孤独，窗边光线暗淡。" };
    expect(rules(unhedged)).toContain("unhedged_speculation");
    const hedged = { ...basePlan, curatorial_statement: "他似乎感到孤独，窗边光线暗淡。" };
    expect(rules(hedged)).not.toContain("unhedged_speculation");
  });

  it("每段文案 ≤100 中文字符；101 字被拒、100 字放行", () => {
    const long = { ...basePlan, curatorial_statement: "窗".repeat(101) };
    expect(rules(long)).toContain("paragraph_too_long");
    const boundary = { ...basePlan, curatorial_statement: "窗".repeat(100) };
    expect(rules(boundary)).not.toContain("paragraph_too_long");
  });

  it("放置理由也受字数约束", () => {
    const plan = {
      ...basePlan,
      chapters: [
        { ...basePlan.chapters[0], placement_reasons: [{ photo_id: "p1", role: "opening" as const, reason: "光".repeat(101) }] },
        ...basePlan.chapters.slice(1),
      ],
    };
    expect(rules(plan)).toContain("paragraph_too_long");
  });

  it("空章节（无照片）被拒", () => {
    const plan = {
      ...basePlan,
      chapters: [basePlan.chapters[0], chapter("chapter_02", "经过", "人物更接近。", []), basePlan.chapters[2]],
    };
    expect(rules(plan)).toContain("empty_chapter");
  });

  it("跨章节重复照片被拒，并点名该照片", () => {
    const plan = {
      ...basePlan,
      chapters: [basePlan.chapters[0], basePlan.chapters[1], chapter("chapter_03", "留下", "光线。", ["p3", "p4"])],
    };
    const v = checkNarrativeCredibility(plan, { keepIds, motifPhotoIds }).violations.find((x) => x.rule === "duplicate_photo");
    expect(v).toBeTruthy();
    expect(v!.photo_ids).toContain("p3");
  });

  it("章节引用了不在保留集的照片被拒", () => {
    const plan = {
      ...basePlan,
      chapters: [chapter("chapter_01", "进入", "空间。", ["p1", "pX"]), ...basePlan.chapters.slice(1)],
    };
    expect(rules(plan)).toContain("photo_not_kept");
  });

  it("主题证据照片未出现在叙事中 → motif_no_evidence", () => {
    expect(rules(basePlan, { keepIds, motifPhotoIds: ["pZ"] })).toContain("motif_no_evidence");
  });
});
import { describe, it, expect } from "vitest";
import { mergeNarrative, assertNarrativeStructure } from "@/lib/orchestrator/merge";
import { NarrativePlan, type NarrativePlanT, type ChapterT } from "@/lib/agents/schemas";
import { checkNarrativeCredibility } from "@/lib/agents/credibility";
import type { UserEditDTO } from "@/types";

function ch(id: string, title: string, photo_ids: string[], locked = false): ChapterT {
  return {
    id, title, description: `${title}的描述。`, photo_ids,
    opening_photo_id: photo_ids[0], closing_photo_id: photo_ids[photo_ids.length - 1],
    placement_reasons: [], locked,
  };
}

const base: NarrativePlanT = {
  title: "在光线转弯之前",
  subtitle: "一组关于窗、背影与经过的照片",
  curatorial_statement: "窗与光线反复出现，像是在记录经过而非停留。",
  chapters: [ch("chapter_01", "进入", ["a", "b"]), ch("chapter_02", "经过", ["c", "d"]), ch("chapter_03", "留下", ["e", "f"])],
  tone: "restrained",
};
const ALL = ["a", "b", "c", "d", "e", "f"];

let seq = 0;
function edit(target_path: string, value: unknown, locked = false): UserEditDTO {
  seq += 1;
  const ts = `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`;
  return { id: `edit_${seq}`, exhibition_id: "exh", target_path, value, locked, created_at: ts, updated_at: ts };
}
const merge = (edits: UserEditDTO[], keepIds = ALL, mustKeepIds: string[] = [], b = base) =>
  mergeNarrative(b, edits, { keepIds, mustKeepIds });
const ids = (p: NarrativePlanT) => p.chapters.flatMap((c) => c.photo_ids);

describe("mergeNarrative — 用户编辑/锁定覆盖 + must_keep 调和（§5.2 / 提示词8）", () => {
  it("ordinary kept candidates may be omitted but must-keep candidates may not", () => {
    const partial = { ...base, chapters: [ch("one", "进入", ["a"]), ch("two", "留下", ["b"])] };
    expect(() => assertNarrativeStructure(partial, { keepIds: ALL, mustKeepIds: ["a"], motifPhotoIds: ["a"] })).not.toThrow();
    expect(() => assertNarrativeStructure(partial, { keepIds: ALL, mustKeepIds: ["f"] })).toThrow();
    expect(() => assertNarrativeStructure(partial, { keepIds: ["a"], mustKeepIds: [] })).toThrow();
  });
  it("无编辑 → 基线原样保留", () => {
    const m = merge([]);
    expect(m.title).toBe(base.title);
    expect(m.chapters.map((c) => c.photo_ids)).toEqual([["a", "b"], ["c", "d"], ["e", "f"]]);
  });

  it("文本覆盖：标题/策展语", () => {
    const m = merge([edit("narrative.title", "我的标题"), edit("narrative.curatorial_statement", "我的策展语")]);
    expect(m.title).toBe("我的标题");
    expect(m.curatorial_statement).toBe("我的策展语");
  });

  it("锁定的标题/策展语在重跑（新基线）后仍在", () => {
    const edits = [edit("narrative.title", "锁定标题", true), edit("narrative.curatorial_statement", "锁定策展语", true)];
    const newBase: NarrativePlanT = { ...base, title: "AI 新标题", curatorial_statement: "AI 新策展语", tone: "poetic" };
    const m = mergeNarrative(newBase, edits, { keepIds: ALL, mustKeepIds: [] });
    expect(m.title).toBe("锁定标题");
    expect(m.curatorial_statement).toBe("锁定策展语");
    expect(m.tone).toBe("poetic");
  });

  it("章节顺序覆盖", () => {
    const m = merge([edit("narrative.chapter_order", ["chapter_03", "chapter_01", "chapter_02"])]);
    expect(m.chapters.map((c) => c.id)).toEqual(["chapter_03", "chapter_01", "chapter_02"]);
  });

  it("章内照片顺序覆盖，开场随之改变", () => {
    const m = merge([edit("chapter:chapter_01.photo_order", ["b", "a"])]);
    expect(m.chapters[0].photo_ids).toEqual(["b", "a"]);
    expect(m.chapters[0].opening_photo_id).toBe("b");
  });

  it("跨章归属：照片移到另一章，无重复", () => {
    const m = merge([edit("photo:a.membership", "chapter_03")]);
    expect(m.chapters[0].photo_ids).toEqual(["b"]);
    expect(m.chapters[2].photo_ids).toContain("a");
    expect(ids(m).filter((x) => x === "a").length).toBe(1);
  });

  it("删除照片（不在 keep 集）→ 移出所有章节", () => {
    const m = merge([], ["a", "b", "d", "e", "f"]);
    expect(ids(m)).not.toContain("c");
    expect(m.chapters.find((c) => c.id === "chapter_02")!.photo_ids).toEqual(["d"]);
  });

  it("must_keep 不在 AI 基线 → 被补回，恰好一次", () => {
    const m = merge([], [...ALL, "z"], ["z"]);
    expect(ids(m).filter((x) => x === "z").length).toBe(1);
  });

  it("锁定章节即使照片被删空也不丢弃，而是补入照片", () => {
    const edits = [edit("chapter:chapter_02.locked", true)];
    const m = merge(edits, ["a", "b", "e", "f"]);
    const c2 = m.chapters.find((c) => c.id === "chapter_02");
    expect(c2).toBeTruthy();
    expect(c2!.photo_ids.length).toBeGreaterThanOrEqual(1);
    expect(c2!.locked).toBe(true);
  });

  it("非锁定空章节被丢弃", () => {
    const m = merge([], ["a", "b", "e", "f"]);
    expect(m.chapters.find((c) => c.id === "chapter_02")).toBeUndefined();
    expect(m.chapters.length).toBe(2);
  });

  it("placement=opening 把照片移到章首", () => {
    const m = merge([edit("photo:b.placement", "opening")]);
    expect(m.chapters[0].photo_ids[0]).toBe("b");
    expect(m.chapters[0].opening_photo_id).toBe("b");
  });

  it("引用已删除照片的编辑被安全忽略", () => {
    const m = merge([edit("photo:c.membership", "chapter_03")], ["a", "b", "d", "e", "f"]);
    expect(ids(m)).not.toContain("c");
  });

  it("删到只剩一章时自动拆成 ≥2 章，输出仍合法", () => {
    const m = merge([], ["a", "b"]);
    expect(m.chapters.length).toBeGreaterThanOrEqual(2);
    expect(NarrativePlan.safeParse(m).success).toBe(true);
    expect(new Set(ids(m)).size).toBe(ids(m).length);
  });

  it("合并结果通过 NarrativePlan 与可信边界校验", () => {
    const edits = [
      edit("narrative.title", "锁定的标题", true),
      edit("photo:a.membership", "chapter_03"),
      edit("chapter:chapter_01.photo_order", ["b"]),
    ];
    const m = merge(edits);
    expect(NarrativePlan.safeParse(m).success).toBe(true);
    const report = checkNarrativeCredibility(m, { keepIds: ALL, motifPhotoIds: ["a", "c"] });
    expect(report.ok).toBe(true);
  });

  it("不修改传入的基线对象", () => {
    const snapshot = JSON.stringify(base);
    merge([edit("narrative.title", "改"), edit("photo:a.membership", "chapter_03")]);
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});

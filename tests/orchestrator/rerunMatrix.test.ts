import { describe, it, expect } from "vitest";
import { rerunRule, clampRange, retryRange } from "@/lib/orchestrator/rerunMatrix";

describe("rerunMatrix 数据驱动局部重跑矩阵", () => {
  it("删除照片 → motifs→qa，stale_from=motifs", () => {
    expect(rerunRule("delete_photo")).toEqual({
      rerun: true,
      from: "motifs",
      to: "qa",
      stale_from: "motifs",
    });
  });

  it("must_keep → narrative→qa；带 include_motifs → motifs→qa", () => {
    expect(rerunRule("must_keep")).toMatchObject({ rerun: true, from: "narrative", to: "qa", stale_from: "narrative" });
    expect(rerunRule("must_keep_with_motifs")).toMatchObject({ rerun: true, from: "motifs", to: "qa", stale_from: "motifs" });
  });

  it("覆盖决定 / 选另一主题 / 改语气 → narrative→qa", () => {
    for (const a of ["override_decision", "select_theme", "change_tone"] as const) {
      expect(rerunRule(a)).toMatchObject({ rerun: true, from: "narrative", to: "qa", stale_from: "narrative" });
    }
  });

  it("换模板 / 重排章节 / 拖照片 → layout→qa", () => {
    for (const a of ["change_template", "reorder_chapters", "reorder_photos"] as const) {
      expect(rerunRule(a)).toMatchObject({ rerun: true, from: "layout", to: "qa", stale_from: "layout" });
    }
  });

  it("改文案 / 改主题名 / 锁定 → 不重跑，stale_from=null", () => {
    for (const a of ["edit_text", "rename_motif", "lock_field"] as const) {
      expect(rerunRule(a)).toMatchObject({ rerun: false, stale_from: null });
    }
  });

  it("clampRange：ceiling=narrative 截断 to；from 超出 ceiling 或不重跑 → null", () => {
    expect(clampRange(rerunRule("change_tone"), "narrative")).toEqual({ from: "narrative", to: "narrative" });
    expect(clampRange(rerunRule("delete_photo"), "narrative")).toEqual({ from: "motifs", to: "narrative" });
    expect(clampRange(rerunRule("change_template"), "narrative")).toBeNull();
    expect(clampRange(rerunRule("edit_text"), "narrative")).toBeNull();
    expect(clampRange(rerunRule("change_tone"), "qa")).toEqual({ from: "narrative", to: "qa" });
  });

  it("retryRange：failed_stage → 截断到 ceiling 的正常终点", () => {
    expect(retryRange("narrative", "narrative")).toEqual({ from: "narrative", to: "narrative" });
    expect(retryRange("motifs", "narrative")).toEqual({ from: "motifs", to: "narrative" });
    expect(retryRange("select", "qa")).toEqual({ from: "select", to: "qa" });
  });
});
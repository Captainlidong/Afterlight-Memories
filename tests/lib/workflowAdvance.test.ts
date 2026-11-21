import { describe, it, expect } from "vitest";
import { shouldAdvance, type AdvanceInput } from "@/lib/workflowAdvance";

const base: AdvanceInput = {
  pendingWorkflowId: "wf_1",
  status: {
    workflow_id: "wf_1",
    is_running: false,
    exhibition: { status: "awaiting_selection_confirm" },
  },
  expectedStatus: "awaiting_selection_confirm",
  currentPath: "/e/exh_1/material",
  originPath: "/e/exh_1/material",
  consumed: false,
};

describe("shouldAdvance（§19.1 B：自动前进只绑定本次工作流）", () => {
  it("全部条件满足 → true", () => {
    expect(shouldAdvance(base)).toBe(true);
  });

  it("没有待跟踪的工作流（刷新后丢失/从未触发）→ false", () => {
    expect(shouldAdvance({ ...base, pendingWorkflowId: null })).toBe(false);
  });

  it("status 尚未加载 → false", () => {
    expect(shouldAdvance({ ...base, status: undefined })).toBe(false);
  });

  it("历史工作流不触发跳转（workflow_id 不匹配）→ false", () => {
    expect(
      shouldAdvance({ ...base, status: { ...base.status!, workflow_id: "wf_old" } }),
    ).toBe(false);
  });

  it("status 载荷无 workflow_id（旧数据）→ false", () => {
    expect(
      shouldAdvance({ ...base, status: { ...base.status!, workflow_id: null } }),
    ).toBe(false);
  });

  it("仍在运行（HTTP 202 ≠ 完成）→ false", () => {
    expect(
      shouldAdvance({ ...base, status: { ...base.status!, is_running: true } }),
    ).toBe(false);
  });

  it("终态不是期望的休息态（如 stage_failed）→ false", () => {
    expect(
      shouldAdvance({
        ...base,
        status: { ...base.status!, exhibition: { status: "stage_failed" } },
      }),
    ).toBe(false);
  });

  it("中间态（selecting）不等于休息态 → false", () => {
    expect(
      shouldAdvance({
        ...base,
        status: { ...base.status!, exhibition: { status: "selecting" } },
      }),
    ).toBe(false);
  });

  it("用户已离开触发页 → false", () => {
    expect(shouldAdvance({ ...base, currentPath: "/e/exh_1/narrative" })).toBe(false);
  });

  it("已消费（sessionStorage 防刷新/重复跳转）→ false", () => {
    expect(shouldAdvance({ ...base, consumed: true })).toBe(false);
  });
});
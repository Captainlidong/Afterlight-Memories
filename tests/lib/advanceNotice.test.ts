import { describe, it, expect } from "vitest";
import {
  writeNotice,
  readNotice,
  clearNotice,
  noticeShouldShow,
  type KVStorage,
  type AdvanceNotice,
} from "@/lib/advanceNotice";

function fakeStorage(): KVStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

const notice: AdvanceNotice = {
  workflowId: "wf_1",
  expectedStatus: "awaiting_theme_choice",
  targetPath: "/e/exh_1/motifs",
};

const status = {
  workflow_id: "wf_1",
  is_running: false,
  exhibition: { status: "awaiting_theme_choice" },
};

describe("advanceNotice（§19.2：离开触发页 → 可点击通知，绝不拉回）", () => {
  it("write/read 往返一致，clear 后为 null", () => {
    const s = fakeStorage();
    writeNotice(s, "exh_1", notice);
    expect(readNotice(s, "exh_1")).toEqual(notice);
    clearNotice(s, "exh_1");
    expect(readNotice(s, "exh_1")).toBeNull();
  });

  it("损坏的 JSON / 缺字段 → null（不抛错）", () => {
    const s = fakeStorage();
    s.setItem("afterlight.notice.exh_1", "{bad json");
    expect(readNotice(s, "exh_1")).toBeNull();
    s.setItem("afterlight.notice.exh_1", JSON.stringify({ workflowId: "wf_1" }));
    expect(readNotice(s, "exh_1")).toBeNull();
  });

  it("全部条件满足（同工作流、已完成、到期望门、不在目标页）→ true", () => {
    expect(noticeShouldShow({ notice, status, currentPath: "/e/exh_1/narrative" })).toBe(true);
  });

  it("没有通知 → false", () => {
    expect(noticeShouldShow({ notice: null, status, currentPath: "/e/exh_1/material" })).toBe(false);
  });

  it("status 未加载 → false", () => {
    expect(noticeShouldShow({ notice, status: undefined, currentPath: "/e/exh_1/material" })).toBe(false);
  });

  it("工作流已换代（用户又触发了新运行）→ false", () => {
    expect(
      noticeShouldShow({ notice, status: { ...status, workflow_id: "wf_2" }, currentPath: "/e/exh_1/material" }),
    ).toBe(false);
  });

  it("仍在运行 → false（完成后再提示）", () => {
    expect(
      noticeShouldShow({ notice, status: { ...status, is_running: true }, currentPath: "/e/exh_1/material" }),
    ).toBe(false);
  });

  it("终态不是期望门（失败等）→ false", () => {
    expect(
      noticeShouldShow({
        notice,
        status: { ...status, exhibition: { status: "stage_failed" } },
        currentPath: "/e/exh_1/material",
      }),
    ).toBe(false);
  });

  it("已在目标页 → false（不需要提示）", () => {
    expect(noticeShouldShow({ notice, status, currentPath: notice.targetPath })).toBe(false);
  });
});
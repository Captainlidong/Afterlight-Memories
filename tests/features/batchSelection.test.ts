import { describe, it, expect } from "vitest";
import { selectionReducer } from "@/features/selection/batchSelection";

describe("batchSelection reducer（§19.4 作用范围与勾选）", () => {
  it("toggle：未选 → 选中", () => {
    expect(selectionReducer([], { type: "toggle", id: "p1" })).toEqual(["p1"]);
  });

  it("toggle：已选 → 取消", () => {
    expect(selectionReducer(["p1", "p2"], { type: "toggle", id: "p1" })).toEqual(["p2"]);
  });

  it("toggle：不影响其他已选照片", () => {
    expect(selectionReducer(["p1"], { type: "toggle", id: "p2" })).toEqual(["p1", "p2"]);
  });

  it("select_all：固定为点击时的 scope 集合，替换旧勾选", () => {
    expect(selectionReducer(["old"], { type: "select_all", scope: ["p1", "p2"] })).toEqual(["p1", "p2"]);
  });

  it("select_all：scope 去重", () => {
    expect(selectionReducer([], { type: "select_all", scope: ["p1", "p1", "p2"] })).toEqual(["p1", "p2"]);
  });

  it("select_all：空分组 → 空勾选", () => {
    expect(selectionReducer(["p1"], { type: "select_all", scope: [] })).toEqual([]);
  });

  it("invert：分组内已选↔未选互换", () => {
    expect(selectionReducer(["p1"], { type: "invert", scope: ["p1", "p2", "p3"] })).toEqual(["p2", "p3"]);
  });

  it("invert：全选中 → 全不选", () => {
    expect(selectionReducer(["p1", "p2"], { type: "invert", scope: ["p1", "p2"] })).toEqual([]);
  });

  it("clear：切换分组时清空勾选", () => {
    expect(selectionReducer(["p1", "p2"], { type: "clear" })).toEqual([]);
  });

  it("prune：只保留仍存在的照片（后台删除/刷新后）", () => {
    expect(selectionReducer(["p1", "p2", "p3"], { type: "prune", valid: ["p2", "p3", "p4"] })).toEqual(["p2", "p3"]);
  });

  it("prune：全部失效 → 空", () => {
    expect(selectionReducer(["p1"], { type: "prune", valid: [] })).toEqual([]);
  });

  it("纯函数：不修改传入的 state 与 scope", () => {
    const state = Object.freeze(["p1"]);
    const scope = Object.freeze(["p1", "p2"]);
    selectionReducer(state, { type: "toggle", id: "p2" });
    selectionReducer(state, { type: "select_all", scope });
    selectionReducer(state, { type: "invert", scope });
    expect(state).toEqual(["p1"]);
    expect(scope).toEqual(["p1", "p2"]);
  });
});
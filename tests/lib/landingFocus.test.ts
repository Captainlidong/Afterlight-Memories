import { describe, it, expect } from "vitest";
import { markLandingFocus, consumeLandingFocus, type KVStorage } from "@/lib/landingFocus";

function fakeStorage(): KVStorage & { dump: () => Record<string, string> } {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    dump: () => Object.fromEntries(m),
  };
}

describe("landingFocus（§19.2(10)：自动跳转后聚焦标题，只消费一次）", () => {
  it("未标记 → consume 返回 false", () => {
    expect(consumeLandingFocus(fakeStorage(), "exh_1")).toBe(false);
  });

  it("标记后 consume 返回 true，并删除标记（刷新/重渲染不重复聚焦）", () => {
    const s = fakeStorage();
    markLandingFocus(s, "exh_1");
    expect(consumeLandingFocus(s, "exh_1")).toBe(true);
    expect(consumeLandingFocus(s, "exh_1")).toBe(false);
    expect(s.dump()["afterlight.focus.exh_1"]).toBeUndefined();
  });

  it("标记按影展隔离：另一个影展不受影响", () => {
    const s = fakeStorage();
    markLandingFocus(s, "exh_1");
    expect(consumeLandingFocus(s, "exh_2")).toBe(false);
    expect(consumeLandingFocus(s, "exh_1")).toBe(true);
  });

  it("非 \"1\" 的脏值不触发", () => {
    const s = fakeStorage();
    s.setItem("afterlight.focus.exh_1", "0");
    expect(consumeLandingFocus(s, "exh_1")).toBe(false);
  });
});
import { describe, it, expect } from "vitest";
import { groupDuplicates, countDuplicateGroups } from "@/lib/image/duplicates";

describe("groupDuplicates", () => {
  it("完全重复(sha)与近似重复(pHash≤10)聚为一组，异景为 null", () => {
    const items = [
      { id: "a", sha256: "s1", phash: "ffffffffffffffff" },
      { id: "b", sha256: "s2", phash: "fffffffffffffffe" }, // 距 a 1 bit
      { id: "c", sha256: "s3", phash: "0000000000000000" }, // 异景
      { id: "d", sha256: "s1", phash: "1234567890abcdef" }, // 与 a 完全重复
    ];
    const map = groupDuplicates(items);
    expect(map.get("a")).not.toBeNull();
    expect(map.get("a")).toBe(map.get("b"));
    expect(map.get("a")).toBe(map.get("d"));
    expect(map.get("c")).toBeNull();
    expect(countDuplicateGroups(map)).toBe(1);
  });

  it("全不重复 → 每组 null，组数 0", () => {
    const items = [
      { id: "a", sha256: "s1", phash: "0000000000000000" },
      { id: "b", sha256: "s2", phash: "ffffffffffffffff" },
    ];
    const map = groupDuplicates(items);
    expect(map.get("a")).toBeNull();
    expect(map.get("b")).toBeNull();
    expect(countDuplicateGroups(map)).toBe(0);
  });

  it("phash 缺失时仅靠 sha 判重", () => {
    const items = [
      { id: "a", sha256: "s1", phash: null },
      { id: "b", sha256: "s1", phash: null },
      { id: "c", sha256: "s2", phash: null },
    ];
    const map = groupDuplicates(items);
    expect(map.get("a")).toBe(map.get("b"));
    expect(map.get("c")).toBeNull();
  });
});
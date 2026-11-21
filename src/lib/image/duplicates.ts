import { newId } from "../id";
import { hammingDistance, PHASH_DUPLICATE_THRESHOLD } from "./phash";

/**
 * 近似重复分组（设计文档 §12.3）。
 * 文件 sha256 相同 = 完全重复；pHash hamming ≤ 10 = 近似重复。
 * 并查集聚类，≥2 张的组分配 dup_ id；单张为 null。
 * 重复组只是交给审美筛选官的证据，绝不据此自动删除（§6.2 / §12.3）。
 */
export interface DupItem {
  id: string;
  sha256: string;
  phash: string | null;
}

export function groupDuplicates(items: DupItem[]): Map<string, string | null> {
  const parent = new Map<string, string>();
  for (const it of items) parent.set(it.id, it.id);

  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== cur) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      const near =
        a.sha256 === b.sha256 ||
        (a.phash != null &&
          b.phash != null &&
          hammingDistance(a.phash, b.phash) <= PHASH_DUPLICATE_THRESHOLD);
      if (near) union(a.id, b.id);
    }
  }

  const members = new Map<string, string[]>();
  for (const it of items) {
    const root = find(it.id);
    const arr = members.get(root);
    if (arr) arr.push(it.id);
    else members.set(root, [it.id]);
  }

  const result = new Map<string, string | null>();
  for (const ids of members.values()) {
    const gid = ids.length >= 2 ? newId("dup") : null;
    for (const id of ids) result.set(id, gid);
  }
  return result;
}

/** 统计 ≥2 张的重复组数量。 */
export function countDuplicateGroups(map: Map<string, string | null>): number {
  const groups = new Set<string>();
  for (const gid of map.values()) if (gid) groups.add(gid);
  return groups.size;
}
import { describe, it, expect } from "vitest";
import manifest from "@/lib/demo/data/manifest.json";
import { AestheticPrefs, MotifResult } from "@/lib/agents/schemas";
import { demoMotifAdapter, heuristicMotifs } from "@/lib/adapters/demoMotifAdapter";
import { getMotifAdapter } from "@/lib/adapters";
import { demoInspection } from "@/lib/demo/manifest";
import type { MotifPhotoInput } from "@/lib/adapters/types";

const shaByIndex = new Map<number, string>();
for (const [sha, idx] of Object.entries(manifest as Record<string, number>)) {
  shaByIndex.set(idx, sha);
}

function demoInput(): MotifPhotoInput[] {
  const photos: MotifPhotoInput[] = [];
  for (let index = 1; index <= 24; index++) {
    const preset = demoInspection(index)!;
    photos.push({
      photoId: `photo_${index}`,
      sha256: shaByIndex.get(index)!,
      subjects: preset.subjects,
      composition_tags: preset.composition_tags,
      color_temp: null,
      saturation: null,
      brightness_score: 0.5,
      duplicate_group_id: null,
    });
  }
  return photos;
}

const P = (id: string, tags: string[], subjects: string[] = [], colorTemp: number | null = null): MotifPhotoInput => ({
  photoId: id,
  sha256: `sha_${id}`,
  subjects,
  composition_tags: tags,
  color_temp: colorTemp,
  saturation: null,
  brightness_score: 0.5,
  duplicate_group_id: null,
});

describe("demoMotifAdapter — 预设命中", () => {
  it("24 张示例 → 3 主题，photo_ids 为真实 id，通过 MotifResult 校验", async () => {
    const result = await demoMotifAdapter.discover({
      photos: demoInput(),
      prefs: AestheticPrefs.parse({}),
    });
    const parsed = MotifResult.parse(result);
    expect(parsed.motifs.length).toBe(3);
    const titles = parsed.motifs.map((m) => m.title).join("|");
    expect(titles).toContain("窗与背影");
    expect(titles).toContain("蓝色光线");
    expect(titles).toContain("人物与空间之间的距离");
    // 预设 photo_indices 映射为真实 photo_id。
    const win = parsed.motifs.find((m) => m.title.includes("窗与背影"))!;
    expect(win.photo_ids).toContain("photo_1");
    expect(win.photo_ids).toContain("photo_7");
    expect(win.photo_ids.every((id) => id.startsWith("photo_"))).toBe(true);
  });
});

describe("heuristicMotifs — 自有照片兜底", () => {
  it("标签聚类产出 2–4 主题，证据为真实计数", () => {
    const photos = [
      P("a", ["框景", "冷调"], ["窗"], -0.4),
      P("b", ["框景"], ["窗"]),
      P("c", ["框景"], ["门洞"]),
      P("d", ["背影"], ["人物背影"]),
      P("e", ["背影"], ["人物背影"]),
      P("f", ["冷调"], ["书架"], -0.5),
      P("g", ["大留白", "小主体"], ["人物"]),
      P("h", ["大留白"], ["广场"]),
    ];
    const motifs = heuristicMotifs(photos, AestheticPrefs.parse({}));
    expect(motifs.length).toBeGreaterThanOrEqual(2);
    expect(motifs.length).toBeLessThanOrEqual(4);
    for (const m of motifs) {
      expect(m.evidence.length).toBeGreaterThanOrEqual(1);
      expect(m.photo_ids.length).toBeGreaterThanOrEqual(1);
      expect(m.confidence).toBeGreaterThanOrEqual(0);
      expect(m.confidence).toBeLessThanOrEqual(1);
    }
    const frame = motifs.find((m) => m.photo_ids.includes("a") && m.photo_ids.includes("b"));
    expect(frame).toBeTruthy();
    expect(frame!.evidence.join("")).toMatch(/3/); // 3 张框景
  });

  it("无标签纯照片仍产出 ≥2 主题（不死路）", () => {
    const photos = [P("x", []), P("y", []), P("z", [])];
    const motifs = heuristicMotifs(photos, AestheticPrefs.parse({}));
    expect(motifs.length).toBeGreaterThanOrEqual(2);
    expect(MotifResult.safeParse({ motifs }).success).toBe(true);
  });
});

describe("getMotifAdapter — 模式路由", () => {
  it("ai 模式缺少服务端上下文时拒绝创建，不回退 Demo", () => {
    expect(() => getMotifAdapter("ai")).toThrow("服务端数据库与工作流上下文");
  });

  it("demo 模式返回 3 主题", async () => {
    const adapter = getMotifAdapter("demo");
    const result = await adapter.discover({ photos: demoInput(), prefs: AestheticPrefs.parse({}) });
    expect(result.motifs.length).toBe(3);
  });
});
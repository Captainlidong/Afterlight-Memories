import { describe, it, expect } from "vitest";
import manifest from "@/lib/demo/data/manifest.json";
import { AestheticPrefs, CurationResult } from "@/lib/agents/schemas";
import { demoCurationAdapter } from "@/lib/adapters/demoCurationAdapter";
import { getCurationAdapter } from "@/lib/adapters";
import type { CurationPhotoInput } from "@/lib/adapters/types";

const shaByIndex = new Map<number, string>();
for (const [sha, idx] of Object.entries(manifest as Record<string, number>)) {
  shaByIndex.set(idx, sha);
}

function demoInput(): CurationPhotoInput[] {
  const photos: CurationPhotoInput[] = [];
  for (let index = 1; index <= 24; index++) {
    photos.push({
      photoId: `photo_${index}`,
      sha256: shaByIndex.get(index)!,
      sharpness_score: 0.7,
      brightness_score: 0.5,
      highlight_clip_ratio: 0.02,
      shadow_clip_ratio: 0.05,
      color_temp: 0,
      saturation: 0.35,
      subjects: [],
      composition_tags: [],
      duplicate_group_id: index === 20 || index === 21 ? "dup" : null,
    });
  }
  return photos;
}

describe("demoCurationAdapter — 预设命中", () => {
  it("24 张示例 → 17 keep / 4 hold / 3 remove，且通过 zod 校验", async () => {
    const result = await demoCurationAdapter.curate({
      photos: demoInput(),
      prefs: AestheticPrefs.parse({}),
    });
    const parsed = CurationResult.parse(result);
    expect(parsed.decisions.length).toBe(24);
    const count = (d: string) => parsed.decisions.filter((x) => x.decision === d).length;
    expect(count("keep")).toBe(17);
    expect(count("hold")).toBe(4);
    expect(count("remove")).toBe(3);
  });

  it("预设 related_indices 解析为真实 photo_id（p21 关联 p20）", async () => {
    const result = await demoCurationAdapter.curate({
      photos: demoInput(),
      prefs: AestheticPrefs.parse({}),
    });
    const p21 = result.decisions.find((d) => d.photo_id === "photo_21")!;
    expect(p21.decision).toBe("remove");
    expect(p21.related_photo_ids).toContain("photo_20");
  });

  it("门洞柔焦（p22）为 hold，理由提及暂缓而非删除", async () => {
    const result = await demoCurationAdapter.curate({
      photos: demoInput(),
      prefs: AestheticPrefs.parse({}),
    });
    const p22 = result.decisions.find((d) => d.photo_id === "photo_22")!;
    expect(p22.decision).toBe("hold");
    expect(p22.reasons.join("")).toMatch(/暂缓/);
  });
});

describe("getCurationAdapter — 模式路由", () => {
  it("ai 模式缺少服务端上下文时拒绝创建，不回退 Demo", () => {
    expect(() => getCurationAdapter("ai")).toThrow("服务端数据库与工作流上下文");
  });

  it("demo 模式返回可用的 demo 适配器", async () => {
    const adapter = getCurationAdapter("demo");
    const result = await adapter.curate({ photos: demoInput(), prefs: AestheticPrefs.parse({}) });
    expect(result.decisions.length).toBe(24);
  });
});
import { describe, it, expect } from "vitest";
import { demoLayout } from "@/lib/demo/manifest";
import { ExhibitionLayout, type LayoutSectionT } from "@/lib/agents/schemas";

const idByIndex = new Map<number, string>();
for (let i = 1; i <= 24; i++) idByIndex.set(i, `photo_p${String(i).padStart(2, "0")}`);

function photoIds(sections: LayoutSectionT[]): string[] {
  const ids: string[] = [];
  for (const s of sections) {
    if (s.type === "hero" || s.type === "single_image") ids.push(s.photo_id);
    else if (s.type === "image_pair" || s.type === "image_group" || s.type === "ending") ids.push(...s.photo_ids);
  }
  return ids;
}

describe("demo layout.json 预设（§14 / 提示词6）", () => {
  it("demoLayout 输出通过 ExhibitionLayout 校验", () => {
    const layout = demoLayout("cinema_scroll", idByIndex);
    expect(() => ExhibitionLayout.parse(layout)).not.toThrow();
    expect(layout.sections.length).toBeGreaterThan(0);
  });

  it("覆盖 17 张保留照片，无跨 section 重复", () => {
    const layout = demoLayout("cinema_scroll", idByIndex);
    const ids = photoIds(layout.sections);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(17);
  });

  it("色板随模板变化，section 结构不变", () => {
    const dark = demoLayout("cinema_scroll", idByIndex);
    const light = demoLayout("archive_collage", idByIndex);
    expect(dark.background).toBe("#101114");
    expect(light.background).toBe("#f5f1e8");
    expect(light.sections).toEqual(dark.sections);
  });
});
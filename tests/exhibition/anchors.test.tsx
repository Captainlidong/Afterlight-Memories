import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LayoutRenderer } from "@/components/exhibition/LayoutRenderer";
import type { ExhibitionLayoutT } from "@/lib/agents/schemas";
import type { NarrativeDTO, PhotoAsset } from "@/types";

const photo = (id: string): PhotoAsset => ({
  id,
  exhibition_id: "exh_test",
  original_name: `${id}.jpg`,
  storage_path: `uploads/exh_test/${id}.jpg`,
  thumbnail_path: null,
  width: 1600,
  height: 1000,
  mime_type: "image/jpeg",
  file_size: 1000,
  sha256: id,
  phash: null,
  exif: null,
  has_exif: false,
  privacy_status: "clean",
  status: "inspected",
  error_message: null,
  sort_order: 0,
  created_at: "2026-01-01T00:00:00.000Z",
});

const narrative: NarrativeDTO = {
  current_version: 0,
  edit_revision: 0,
  exhibition_id: "exh_test",
  selected_motif_id: null,
  title: "在光线转弯之前",
  subtitle: "",
  curatorial_statement: "窗与光线反复出现，像是在记录经过。",
  tone: "restrained",
  source: "demo",
  chapters: [
    { id: "ch1", title: "进入", description: "空间先于人出现。", photo_ids: ["p1", "p2"], placement_reasons: [], locked: false },
  ],
  input_version: 0,
  run_id: null,
  updated_at: "2026-01-01T00:00:00.000Z",
};

const layout: ExhibitionLayoutT = {
  template: "cinema_scroll",
  background: "#101114",
  text_color: "#f5f1e8",
  sections: [
    { id: "hero", type: "hero", photo_id: "p1", height: "92vh", caption_position: "bottom-left" },
    { id: "intro_ch1", type: "chapter_intro", chapter_id: "ch1", spacing: "large" },
    { id: "single_p1", type: "single_image", photo_id: "p1", size: "medium", spacing: "medium" },
    { id: "pair_p1_p2", type: "image_pair", photo_ids: ["p1", "p2"], ratio: "3:2", gap: "medium" },
    { id: "group_p1_p2", type: "image_group", photo_ids: ["p1", "p2"], gap: "small" },
    { id: "spacer_1", type: "spacer", size: "small" },
    { id: "statement", type: "statement" },
    { id: "ending", type: "ending", photo_ids: ["p2"] },
  ],
};

describe("影展 section 锚点", () => {
  it("所有 section 类型都渲染稳定 id（QA 定位依赖原生 hash 滚动）", () => {
    const html = renderToStaticMarkup(
      <LayoutRenderer layout={layout} narrative={narrative} photos={[photo("p1"), photo("p2")]} exhibitionId="exh_test" />,
    );
    for (const s of layout.sections) {
      expect(html, `section ${s.id} 缺少锚点 id`).toContain(`id="${s.id}"`);
    }
  });

  it("每张图片携带底层加载失败占位，且静态标记不含事件处理器（服务端导出复用）", () => {
    const html = renderToStaticMarkup(
      <LayoutRenderer layout={layout} narrative={narrative} photos={[photo("p1"), photo("p2")]} exhibitionId="exh_test" />,
    );
    const imgCount = (html.match(/<img /g) ?? []).length;
    const fallbackCount = (html.match(/img-fallback/g) ?? []).length;
    expect(imgCount).toBeGreaterThan(0);
    expect(fallbackCount).toBe(imgCount);
    expect(html.toLowerCase()).not.toContain("onerror");
  });
});
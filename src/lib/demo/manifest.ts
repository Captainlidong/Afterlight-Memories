import path from "node:path";
import manifestJson from "./data/manifest.json";
import photosJson from "./data/photos.json";
import inspectionsJson from "./data/inspections.json";
import curationJson from "./data/curation.json";
import motifsJson from "./data/motifs.json";
import narrativeJson from "./data/narrative.json";
import layoutJson from "./data/layout.json";
import type { TemplateT, ExhibitionLayoutT, LayoutSectionT } from "../agents/schemas";

/**
 * Demo 预设索引（设计文档 §9.3 / §14）。
 * manifest：sha256 → 示例序号(1..24)；上传命中即套用预设语义标签。
 * 真实技术指标仍由 sharp 实跑；预设只补充"subjects/composition_tags"语义层。
 */
export const DEMO_COUNT = 24;

const manifest = manifestJson as Record<string, number>;

export interface DemoPhotoMeta {
  index: number;
  original_name: string;
  category: string;
}
export interface DemoInspectionPreset {
  index: number;
  subjects: string[];
  composition_tags: string[];
}
export interface DemoCurationPreset {
  index: number;
  decision: "keep" | "hold" | "remove";
  score: number;
  confidence: number;
  reasons: string[];
  related_indices: number[];
}
export interface DemoMotifPreset {
  title: string;
  description: string;
  photo_indices: number[];
  evidence: string[];
  confidence: number;
  alternative_readings: string[];
}
export interface DemoNarrativeChapterPreset {
  id: string;
  title: string;
  photo_indices: number[];
  opening_index: number;
  closing_index: number;
  turning_index?: number;
}
export interface DemoNarrativePlacementPreset {
  chapter: string;
  index: number;
  role: "opening" | "development" | "turning" | "closing";
  reason: string;
}
export interface DemoNarrativeTonePreset {
  curatorial_statement: string;
  descriptions: string[];
  placement_reasons: DemoNarrativePlacementPreset[];
}
export interface DemoNarrativePreset {
  title: string;
  subtitle: string;
  chapters: DemoNarrativeChapterPreset[];
  tones: Record<string, DemoNarrativeTonePreset>;
}

const photos = photosJson as DemoPhotoMeta[];
const inspections = inspectionsJson as DemoInspectionPreset[];
const curation = curationJson as DemoCurationPreset[];
const motifs = motifsJson as DemoMotifPreset[];
const narrative = narrativeJson as DemoNarrativePreset;
const layoutPreset = layoutJson as { sections: Record<string, unknown>[] };

const LAYOUT_PALETTE: Record<TemplateT, { background: string; text_color: string }> = {
  cinema_scroll: { background: "#101114", text_color: "#f5f1e8" },
  archive_collage: { background: "#f5f1e8", text_color: "#101114" },
};

export function indexBySha(sha256: string): number | null {
  const idx = manifest[sha256];
  return typeof idx === "number" ? idx : null;
}

export function demoPhotoMeta(index: number): DemoPhotoMeta | null {
  return photos.find((p) => p.index === index) ?? null;
}

export function demoInspection(index: number): DemoInspectionPreset | null {
  return inspections.find((i) => i.index === index) ?? null;
}

export function demoCuration(index: number): DemoCurationPreset | null {
  return curation.find((c) => c.index === index) ?? null;
}

/** 示例主题预设（3 个候选，§14 / 提示词4）。photo_indices 指向示例序号。 */
export function demoMotifs(): DemoMotifPreset[] {
  return motifs;
}

/** 示例叙事预设（《在光线转弯之前》三章 + 4 语气变体，§14 / 提示词5）。photo_indices 指向示例序号。 */
export function demoNarrative(): DemoNarrativePreset {
  return narrative;
}

/** 示例布局预设（§14 / 提示词6）。section 与模板无关，仅色板随模板变化；photo_index→真实 id。 */
export function demoLayout(template: TemplateT, idByIndex: Map<number, string>): ExhibitionLayoutT {
  const sections = layoutPreset.sections.map((raw) => {
    const s = { ...raw } as Record<string, unknown>;
    if (typeof s.photo_index === "number") {
      s.photo_id = idByIndex.get(s.photo_index);
      delete s.photo_index;
    }
    if (Array.isArray(s.photo_indices)) {
      s.photo_ids = (s.photo_indices as number[]).map((i) => idByIndex.get(i));
      delete s.photo_indices;
    }
    return s as unknown as LayoutSectionT;
  });
  const palette = LAYOUT_PALETTE[template];
  return { template, background: palette.background, text_color: palette.text_color, sections };
}

/** 示例源图绝对路径（public/demo/photos/pNN.jpg，提交 git 的演示资产）。 */
export function demoPhotoPath(index: number): string {
  const name = `p${String(index).padStart(2, "0")}.jpg`;
  return path.join(process.cwd(), "public", "demo", "photos", name);
}

export function demoPhotoName(index: number): string {
  return `p${String(index).padStart(2, "0")}.jpg`;
}
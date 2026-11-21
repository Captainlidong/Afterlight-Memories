import type { DatabaseSync } from "node:sqlite";
import type { NarrativePlanT, TemplateT, ToneT, LayoutSectionT, ExhibitionLayoutT } from "./schemas";
import { ExhibitionLayout } from "./schemas";
import { listPhotos, listInspections } from "../db/photos";
import { listDecisions } from "../db/curation";
import { getNarrative } from "../db/narrative";
import { replaceLayout } from "../db/layout";
import { updateExhibition } from "../db/repos";
import { indexBySha, demoLayout } from "../demo/manifest";
import { snapshotVersion } from "../orchestrator/versions";
import { ApiError } from "../api/errors";
import type { Exhibition } from "@/types";

/**
 * Agent 5 布局设计师（设计文档 §6.6 / §12.7 / 提示词6）。
 * 纯确定性规则引擎，两模式一致——布局是算法而非 LLM 塑形。
 * 把叙事 plan 的章节/照片顺序转化为 ExhibitionLayout：单 hero、章节 intro 间距随语气、
 * 连续相似照片成 pair/group（绝不 >2 相似满屏）、转折单张大图 + 大留白、结尾 1–2 张。
 * section 只引用 chapter_id/photo_id，文案实时从叙事读取；模板仅决定色板，不改照片与叙事。
 */
export interface DesignerPhoto {
  photoId: string;
  subjects: string[];
  composition_tags: string[];
  color_temp: number | null;
  duplicate_group_id: string | null;
}

export interface DesignerInput {
  plan: NarrativePlanT;
  photos: DesignerPhoto[];
  template: TemplateT;
}

const PALETTE: Record<TemplateT, { background: string; text_color: string }> = {
  cinema_scroll: { background: "#101114", text_color: "#f5f1e8" },
  archive_collage: { background: "#f5f1e8", text_color: "#101114" },
};

type Spacing = "small" | "medium" | "large";

function introSpacing(tone: ToneT): Spacing {
  if (tone === "direct") return "small";
  if (tone === "documentary") return "medium";
  return "large";
}

function similar(a: DesignerPhoto, b: DesignerPhoto): boolean {
  if (a.duplicate_group_id && a.duplicate_group_id === b.duplicate_group_id) return true;
  return a.subjects.some((s) => b.subjects.includes(s));
}

function singleSize(id: string, opening: Set<string>, template: TemplateT, idx: number): "medium" | "large" {
  if (opening.has(id)) return "large";
  if (template === "archive_collage") return idx % 2 === 0 ? "large" : "medium";
  return "medium";
}

export function designLayout(input: DesignerInput): ExhibitionLayoutT {
  const { plan, template } = input;
  const byId = new Map(input.photos.map((p) => [p.photoId, p]));
  const palette = PALETTE[template];
  const spacing = introSpacing(plan.tone);
  const chapters = plan.chapters;
  const sections: LayoutSectionT[] = [];

  const heroId = chapters[0].opening_photo_id ?? chapters[0].photo_ids[0];
  sections.push({ id: "hero", type: "hero", photo_id: heroId, height: "92vh", caption_position: "bottom-left" });

  const last = chapters[chapters.length - 1];
  const closingId = last.closing_photo_id ?? last.photo_ids[last.photo_ids.length - 1];
  const endingIds = [closingId];

  chapters.forEach((ch, ci) => {
    sections.push({ id: `intro_${ch.id}`, type: "chapter_intro", chapter_id: ch.id, spacing });
    const turning = new Set(ch.placement_reasons.filter((r) => r.role === "turning").map((r) => r.photo_id));
    const opening = new Set(ch.placement_reasons.filter((r) => r.role === "opening").map((r) => r.photo_id));
    const isLast = ci === chapters.length - 1;
    const body = ch.photo_ids.filter((id) => !(ci === 0 && id === heroId) && !(isLast && endingIds.includes(id)));

    let i = 0;
    while (i < body.length) {
      const id = body[i];
      if (turning.has(id)) {
        sections.push({ id: `spacer_${id}`, type: "spacer", size: "large" });
        sections.push({ id: `single_${id}`, type: "single_image", photo_id: id, size: "large", spacing: "large" });
        i++;
        continue;
      }
      const anchor = byId.get(id);
      let j = i + 1;
      while (j < body.length && !turning.has(body[j]) && anchor && byId.get(body[j]) && similar(anchor, byId.get(body[j])!)) j++;
      const run = body.slice(i, j);
      if (run.length >= 2) {
        let k = 0;
        while (k < run.length) {
          const remaining = run.length - k;
          if (remaining === 1) {
            const rid = run[k];
            sections.push({ id: `single_${rid}`, type: "single_image", photo_id: rid, size: singleSize(rid, opening, template, k), spacing });
            k++;
          } else {
            const chunk = run.slice(k, k + Math.min(4, remaining));
            if (chunk.length === 2) {
              sections.push({ id: `pair_${chunk[0]}_${chunk[1]}`, type: "image_pair", photo_ids: [chunk[0], chunk[1]], ratio: "60-40", gap: "medium" });
            } else {
              sections.push({ id: `group_${chunk[0]}`, type: "image_group", photo_ids: chunk, gap: "small" });
            }
            k += chunk.length;
          }
        }
        i = j;
      } else {
        sections.push({ id: `single_${id}`, type: "single_image", photo_id: id, size: singleSize(id, opening, template, i), spacing });
        i++;
      }
    }
  });

  sections.push({ id: "statement", type: "statement" });
  sections.push({ id: "ending", type: "ending", photo_ids: endingIds });

  return { template, background: palette.background, text_color: palette.text_color, sections };
}

export interface LayoutOutput {
  template: TemplateT;
  section_count: number;
  photo_count: number;
  source: string;
  preset_hits: number;
  version: number;
}

/**
 * 编排器入口：读取当前叙事 plan + 保留照片，生成布局并落库。
 * 叙事不存在 → 409（门）。demo 命中且预设可完整映射 → 预设布局；否则规则引擎。
 * 落库后写版本快照并清 stale_from。模板切换只重跑 layout（照片/叙事不变）。
 */
export async function runExhibition(
  db: DatabaseSync,
  ctx: { runId: string; exhibition: Exhibition; assertOwner?: () => void },
): Promise<LayoutOutput> {
  const exh = ctx.exhibition;
  const narrative = getNarrative(db, exh.id);
  if (!narrative) {
    throw new ApiError(409, "narrative_not_ready", "请先生成叙事，再进行布局设计。");
  }

  const decisions = listDecisions(db, exh.id);
  const keepSet = new Set(
    decisions.filter((d) => d.effective_decision === "keep" || d.effective_decision === "must_keep").map((d) => d.photo_id),
  );
  const photos = listPhotos(db, exh.id).filter((p) => keepSet.has(p.id));
  const inspections = new Map(listInspections(db, exh.id).map((i) => [i.photo_id, i]));

  const designerPhotos: DesignerPhoto[] = [];
  const idByIndex = new Map<number, string>();
  let presetHits = 0;
  for (const photo of photos) {
    const ins = inspections.get(photo.id);
    if (!ins) continue;
    const idx = indexBySha(photo.sha256);
    if (idx != null) {
      presetHits++;
      idByIndex.set(idx, photo.id);
    }
    designerPhotos.push({
      photoId: photo.id,
      subjects: ins.subjects,
      composition_tags: ins.composition_tags,
      color_temp: ins.color_temp ?? null,
      duplicate_group_id: ins.duplicate_group_id ?? null,
    });
  }
  if (designerPhotos.length === 0) {
    throw new ApiError(400, "no_keep_photos", "没有保留照片可供布局，请先在筛选页保留一些照片。");
  }

  const plan: NarrativePlanT = {
    title: narrative.title,
    subtitle: narrative.subtitle,
    curatorial_statement: narrative.curatorial_statement,
    chapters: narrative.chapters,
    tone: narrative.tone,
  };

  let layout: ExhibitionLayoutT;
  let source: string;
  const preset = presetHits / designerPhotos.length >= 0.8 ? demoLayout(exh.template, idByIndex) : null;
  const presetValid = preset ? ExhibitionLayout.safeParse(preset) : null;
  if (presetValid?.success) {
    layout = presetValid.data;
    source = "demo_preset";
  } else {
    layout = designLayout({ plan, photos: designerPhotos, template: exh.template });
    source = "heuristic";
  }
  layout = ExhibitionLayout.parse(layout);

  let version: number;
  db.exec("BEGIN IMMEDIATE");
  try {
    ctx.assertOwner?.();
    replaceLayout(db, exh.id, layout, { inputVersion: exh.current_version, runId: ctx.runId });
    version = snapshotVersion(db, exh.id, "布局设计");
    updateExhibition(db, exh.id, { stale_from: null });
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }

  return {
    template: layout.template,
    section_count: layout.sections.length,
    photo_count: designerPhotos.length,
    source,
    preset_hits: presetHits,
    version,
  };
}
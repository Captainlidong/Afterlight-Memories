import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createDb } from "@/lib/db/client";
import { createExhibition, getExhibition } from "@/lib/db/repos";
import { insertPhotoAsset, upsertInspection } from "@/lib/db/photos";
import { upsertAiDecision } from "@/lib/db/curation";
import { listMotifs, selectMotif } from "@/lib/db/motifs";
import { CreateExhibitionInput, PhotoInspection, VisualFacts } from "@/lib/agents/schemas";
import { runSelect } from "@/lib/agents/aestheticSelector";
import { runMotifs } from "@/lib/agents/motifFinder";
import { runNarrative } from "@/lib/agents/narrativeEditor";
import { demoCurationAdapter } from "@/lib/adapters/demoCurationAdapter";
import { demoMotifAdapter } from "@/lib/adapters/demoMotifAdapter";
import { demoNarrativeAdapter } from "@/lib/adapters/demoNarrativeAdapter";

const FACTS = VisualFacts.parse({
  summary: "人物站在窗边，窗外光线较亮。",
  subjects: ["窗", "人物背影"],
  composition_tags: ["框景", "人物位于画面边缘"],
  light_tags: ["侧光", "室内外明暗对比"],
  spatial_relations: ["人物靠近窗边"],
  evidence: [{ kind: "observation", text: "人物没有正面朝向镜头" }],
  uncertainties: ["无法判断人物与拍摄者的关系"],
});

describe("视觉事实贯通（V08）", () => {
  let db: DatabaseSync;
  let exhibitionId: string;

  beforeEach(() => {
    db = createDb(":memory:");
    exhibitionId = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    for (let i = 0; i < 4; i++) {
      const id = `photo_${i}`;
      insertPhotoAsset(db, {
        id,
        exhibition_id: exhibitionId,
        original_name: `${i}.jpg`,
        storage_path: "unused.jpg",
        thumbnail_path: null,
        width: 100,
        height: 80,
        mime_type: "image/jpeg",
        file_size: 100,
        sha256: String(i).repeat(64),
        sort_order: i,
      });
      upsertInspection(db, PhotoInspection.parse({
        photo_id: id,
        sharpness_score: 0.7,
        laplacian_var: 100,
        brightness_score: 0.5,
        highlight_clip_ratio: 0.01,
        shadow_clip_ratio: 0.02,
        dominant_colors: ["#445566"],
        color_temp: -0.2,
        saturation: 0.3,
        subjects: i < 2 ? ["窗", "人物背影"] : ["走廊"],
        composition_tags: i < 2 ? ["框景"] : ["纵深"],
        visual_facts: { ...FACTS, summary: `第 ${i + 1} 张：${FACTS.summary}` },
        visual_source: "fresh",
        analysis_image_sha256: String(i + 4).repeat(64),
        duplicate_group_id: null,
        processing_mode: "ai",
      }));
      upsertAiDecision(db, exhibitionId, {
        photo_id: id,
        decision: "keep",
        score: 0.8,
        confidence: 0.7,
        reasons: ["具体构图与光线"],
        related_photo_ids: [],
        user_override_allowed: true,
      }, "run_seed");
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it("数据库中的扩展事实逐张进入选片、主题与叙事输入，不在映射中丢失", async () => {
    const selectSpy = vi.spyOn(demoCurationAdapter, "curate");
    const motifSpy = vi.spyOn(demoMotifAdapter, "discover");
    const narrativeSpy = vi.spyOn(demoNarrativeAdapter, "compose");
    const exhibition = getExhibition(db, exhibitionId)!;

    await runSelect(db, { runId: "run_select", exhibition });
    expect(selectSpy).toHaveBeenCalledOnce();
    expect(selectSpy.mock.calls[0][0].photos).toHaveLength(4);
    expect(selectSpy.mock.calls[0][0].photos[0].visual_facts?.summary).toContain("第 1 张");
    expect(selectSpy.mock.calls[0][0].photos[0].visual_facts?.light_tags).toEqual(FACTS.light_tags);

    await runMotifs(db, { runId: "run_motifs", exhibition });
    expect(motifSpy).toHaveBeenCalledOnce();
    expect(motifSpy.mock.calls[0][0].photos).toHaveLength(4);
    expect(motifSpy.mock.calls[0][0].photos[1].visual_facts?.spatial_relations).toEqual(FACTS.spatial_relations);
    expect(motifSpy.mock.calls[0][0].photos[1].visual_facts?.uncertainties).toEqual(FACTS.uncertainties);

    const motif = listMotifs(db, exhibitionId)[0];
    selectMotif(db, exhibitionId, motif.id);
    await runNarrative(db, {
      runId: "run_narrative",
      exhibition: getExhibition(db, exhibitionId)!,
    });
    expect(narrativeSpy).toHaveBeenCalledOnce();
    expect(narrativeSpy.mock.calls[0][0].photos).toHaveLength(4);
    expect(narrativeSpy.mock.calls[0][0].photos[2].visual_facts?.evidence).toEqual(FACTS.evidence);
  });
});

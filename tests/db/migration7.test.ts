import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createDb } from "@/lib/db/client";
import { MIGRATIONS, migrate } from "@/lib/db/migrations";
import { createExhibition } from "@/lib/db/repos";
import { getInspection, insertPhotoAsset, upsertInspection } from "@/lib/db/photos";
import { CreateExhibitionInput, PhotoInspection, VisualFacts } from "@/lib/agents/schemas";

const FACTS = VisualFacts.parse({
  summary: "窗边的背影。",
  subjects: ["窗", "人物背影"],
  composition_tags: ["框景"],
  light_tags: ["侧光"],
  spatial_relations: ["人物靠近窗边"],
  evidence: [{ kind: "observation", text: "人物背对镜头" }],
  uncertainties: [],
});

function seedPhoto(db: DatabaseSync, exhibitionId: string) {
  insertPhotoAsset(db, {
    id: "photo_1",
    exhibition_id: exhibitionId,
    original_name: "one.jpg",
    storage_path: "unused.jpg",
    thumbnail_path: null,
    width: 100,
    height: 80,
    mime_type: "image/jpeg",
    file_size: 100,
    sha256: "a".repeat(64),
    sort_order: 0,
  });
}

describe("migration 7 — 视觉事实与来源（V08/V35）", () => {
  it("事实、缓存来源和分析图哈希完整落库；旧字段继续兼容", () => {
    const db = createDb(":memory:");
    const exhibitionId = createExhibition(db, CreateExhibitionInput.parse({}), "ai").id;
    seedPhoto(db, exhibitionId);
    upsertInspection(db, PhotoInspection.parse({
      photo_id: "photo_1",
      sharpness_score: 0.7,
      laplacian_var: 100,
      brightness_score: 0.5,
      highlight_clip_ratio: 0.01,
      shadow_clip_ratio: 0.02,
      dominant_colors: ["#445566"],
      subjects: FACTS.subjects,
      composition_tags: FACTS.composition_tags,
      visual_embedding: null,
      visual_facts: FACTS,
      visual_source: "cache",
      analysis_image_sha256: "b".repeat(64),
      duplicate_group_id: null,
      processing_mode: "ai",
    }));
    const saved = getInspection(db, "photo_1")!;
    expect(saved.visual_facts).toEqual(FACTS);
    expect(saved.visual_source).toBe("cache");
    expect(saved.analysis_image_sha256).toBe("b".repeat(64));
    expect(saved.subjects).toEqual(FACTS.subjects);
    db.close();
  });

  it("v6 旧库增量升级：照片和检查记录保留，新增事实为空而非假 AI 完成", () => {
    const db = new DatabaseSync(":memory:");
    for (let i = 0; i < 6; i++) db.exec(MIGRATIONS[i]);
    db.exec("PRAGMA user_version=6");
    db.prepare(
      `INSERT INTO exhibitions (id, title, status, created_at, updated_at)
       VALUES ('exh_old', '旧影展', 'draft', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run();
    seedPhoto(db, "exh_old");
    db.prepare(
      `INSERT INTO photo_inspections
       (photo_id, sharpness_score, laplacian_var, brightness_score, highlight_clip_ratio,
        shadow_clip_ratio, dominant_colors, subjects, composition_tags, processing_mode, created_at)
       VALUES ('photo_1', 0.7, 100, 0.5, 0.01, 0.02, '[]', '["旧主体"]', '[]', 'heuristic',
        '2026-01-01T00:00:00Z')`,
    ).run();

    migrate(db);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
    const saved = getInspection(db, "photo_1")!;
    expect(saved.subjects).toEqual(["旧主体"]);
    expect(saved.processing_mode).toBe("heuristic");
    expect(saved.visual_facts).toBeNull();
    expect(saved.visual_source).toBeNull();
    expect(saved.analysis_image_sha256).toBeNull();
    db.close();
  });
});

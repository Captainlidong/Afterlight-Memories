import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createDb } from "@/lib/db/client";
import { createExhibition, getExhibition, updateExhibition } from "@/lib/db/repos";
import { insertPhotoAsset, upsertInspection } from "@/lib/db/photos";
import { upsertAiDecision, setUserOverride } from "@/lib/db/curation";
import { replaceMotifs, listMotifs, selectMotif } from "@/lib/db/motifs";
import { getNarrative } from "@/lib/db/narrative";
import { upsertEdit } from "@/lib/db/edits";
import { listVersions } from "@/lib/db/versions";
import { getRun } from "@/lib/db/runs";
import { CreateExhibitionInput, PhotoInspection, Motif } from "@/lib/agents/schemas";
import { startPipeline, isRunning } from "@/lib/orchestrator/orchestrator";
import { prepareUpload } from "@/lib/image/pipeline";
import { uploadsDir, toRelative } from "@/lib/files";
import { newId } from "@/lib/id";
import type { DatabaseSync } from "node:sqlite";

let db: DatabaseSync;
let tmp: string;

async function seedPhoto(
  exhId: string,
  opts: { tags?: string[]; subjects?: string[]; decision?: "keep" | "hold" | "remove"; override?: "must_keep"; brightness?: number } = {},
): Promise<string> {
  const buf = await sharp({
    create: { width: 120, height: 90, channels: 3, background: { r: 70, g: 90, b: 130 } },
  }).jpeg().toBuffer();
  const id = newId("photo");
  const prepared = await prepareUpload(buf);
  const dir = uploadsDir(exhId);
  fs.mkdirSync(dir, { recursive: true });
  const origAbs = path.join(dir, `${id}.jpg`);
  fs.writeFileSync(origAbs, buf);
  fs.writeFileSync(path.join(dir, `thumb_${id}.jpg`), prepared.thumbnail);
  insertPhotoAsset(db, {
    id, exhibition_id: exhId, original_name: "x.jpg",
    storage_path: toRelative(origAbs), thumbnail_path: toRelative(path.join(dir, `thumb_${id}.jpg`)),
    width: prepared.width, height: prepared.height, mime_type: "image/jpeg",
    file_size: buf.length, sha256: prepared.sha256, sort_order: 0,
  });
  upsertInspection(db, PhotoInspection.parse({
    photo_id: id, sharpness_score: 0.7, laplacian_var: 100,
    brightness_score: opts.brightness ?? 0.5,
    highlight_clip_ratio: 0.02, shadow_clip_ratio: 0.05, dominant_colors: ["#465a82"],
    color_temp: null, saturation: 0.3, subjects: opts.subjects ?? [], composition_tags: opts.tags ?? [],
    duplicate_group_id: null, processing_mode: "heuristic",
  }));
  upsertAiDecision(db, exhId, {
    photo_id: id, decision: opts.decision ?? "keep", score: 0.7, confidence: 0.6,
    reasons: ["test"], related_photo_ids: [], user_override_allowed: true,
  });
  if (opts.override) setUserOverride(db, exhId, id, opts.override, "必留");
  return id;
}

/** 绕过 motifs agent，直接落一组候选并选主线（隔离测试 narrative 阶段）。 */
function seedSelectedMotif(exhId: string, photoIds: string[]): string {
  replaceMotifs(db, exhId, [
    Motif.parse({
      title: "窗与背影",
      description: "框景反复出现。",
      photo_ids: photoIds,
      evidence: [`${photoIds.length} 张框景`],
      confidence: 0.7,
    }),
  ]);
  const motifId = listMotifs(db, exhId)[0].id;
  selectMotif(db, exhId, motifId);
  return motifId;
}

async function waitDone(exhId: string, timeout = 8000): Promise<void> {
  const start = Date.now();
  while (isRunning(db, exhId)) {
    if (Date.now() - start > timeout) throw new Error("pipeline 超时");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-narrative-"));
  process.env.AFTERLIGHT_DATA_DIR = tmp;
  db = createDb(":memory:");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.AFTERLIGHT_DATA_DIR;
});

describe("narrative 管线（demo 启发式）", () => {
  it("选主题后跑 narrative → 叙事落库 + status designing + 版本快照", async () => {
    const exh = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    const keepIds = [
      await seedPhoto(exh, { tags: ["框景"], subjects: ["窗"] }),
      await seedPhoto(exh, { tags: ["纵深"], subjects: ["走廊"] }),
      await seedPhoto(exh, { tags: ["背影"], subjects: ["人物背影"], brightness: 0.8 }),
      await seedPhoto(exh, { tags: ["反光"], subjects: ["玻璃"] }),
    ];
    await seedPhoto(exh, { decision: "hold" });
    seedSelectedMotif(exh, keepIds);

    const { run_id } = startPipeline(db, exh, "narrative", "narrative");
    await waitDone(exh);
    expect(getExhibition(db, exh)!.status).toBe("designing");
    expect(getRun(db, run_id)!.status).toBe("completed");
    const narrative = getNarrative(db, exh)!;
    expect(narrative).not.toBeNull();
    expect(narrative.chapters.length).toBeGreaterThanOrEqual(2);
    expect(narrative.tone).toBe("restrained");
    expect(narrative.source).toBe("heuristic");
    const inNarrative = new Set(narrative.chapters.flatMap((c) => c.photo_ids));
    for (const pid of keepIds) expect(inNarrative.has(pid)).toBe(true);
    expect(getExhibition(db, exh)!.current_version).toBeGreaterThanOrEqual(1);
    expect(listVersions(db, exh).length).toBeGreaterThanOrEqual(1);
  });

  it("改标题 + 锁策展语 → 改语气重跑 → 标题与策展语仍在（阶段4验收）", async () => {
    const exh = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    const ids = [
      await seedPhoto(exh, { tags: ["框景"] }),
      await seedPhoto(exh, { tags: ["背影"], subjects: ["人物背影"] }),
      await seedPhoto(exh, { tags: ["反光"], subjects: ["水面"] }),
    ];
    seedSelectedMotif(exh, ids);
    startPipeline(db, exh, "narrative", "narrative");
    await waitDone(exh);
    expect(getNarrative(db, exh)!.tone).toBe("restrained");

    upsertEdit(db, exh, "narrative.title", "我的影展", false);
    upsertEdit(db, exh, "narrative.curatorial_statement", "我锁定的策展语。", true);
    updateExhibition(db, exh, { tone: "poetic" });

    startPipeline(db, exh, "narrative", "narrative");
    await waitDone(exh);
    const narrative = getNarrative(db, exh)!;
    expect(narrative.title).toBe("我的影展");
    expect(narrative.curatorial_statement).toBe("我锁定的策展语。");
    expect(narrative.tone).toBe("poetic");
    expect(getExhibition(db, exh)!.status).toBe("designing");
  });

  it("must_keep 照片（AI 判 remove）重跑后仍在叙事中", async () => {
    const exh = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    const ids = [
      await seedPhoto(exh, { tags: ["框景"] }),
      await seedPhoto(exh, { tags: ["框景"] }),
      await seedPhoto(exh, { tags: ["背影"], subjects: ["人物背影"] }),
    ];
    const must = await seedPhoto(exh, { decision: "remove", override: "must_keep" });
    seedSelectedMotif(exh, [...ids, must]);
    startPipeline(db, exh, "narrative", "narrative");
    await waitDone(exh);
    const narrative = getNarrative(db, exh)!;
    expect(narrative.chapters.some((c) => c.photo_ids.includes(must))).toBe(true);
  });

  it("保留照片被全部移除 → stage_failed narrative，主题表不动", async () => {
    const exh = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    const a = await seedPhoto(exh, {});
    const b = await seedPhoto(exh, {});
    seedSelectedMotif(exh, [a, b]);
    setUserOverride(db, exh, a, "remove", "不要了");
    setUserOverride(db, exh, b, "remove", "不要了");
    const { run_id } = startPipeline(db, exh, "narrative", "narrative");
    await waitDone(exh);
    const e = getExhibition(db, exh)!;
    expect(e.status).toBe("stage_failed");
    expect(e.failed_stage).toBe("narrative");
    expect(getRun(db, run_id)!.status).toBe("failed");
    expect(getNarrative(db, exh)).toBeNull();
    expect(listMotifs(db, exh).length).toBe(1);
  });

  it("仅一张保留照片 → stage_failed narrative（too_few_photos）", async () => {
    const exh = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    const a = await seedPhoto(exh, {});
    seedSelectedMotif(exh, [a]);
    const { run_id } = startPipeline(db, exh, "narrative", "narrative");
    await waitDone(exh);
    expect(getExhibition(db, exh)!.status).toBe("stage_failed");
    expect(getExhibition(db, exh)!.failed_stage).toBe("narrative");
    expect(getRun(db, run_id)!.error_message).toContain("两张");
    expect(getNarrative(db, exh)).toBeNull();
  });
});

describe("narrative 管线（ai 未配置）", () => {
  it("ai 模式 → stage_failed narrative，叙事表为空", async () => {
    const exh = createExhibition(db, CreateExhibitionInput.parse({}), "ai").id;
    const a = await seedPhoto(exh, {});
    const b = await seedPhoto(exh, {});
    seedSelectedMotif(exh, [a, b]);
    const { run_id } = startPipeline(db, exh, "narrative", "narrative");
    await waitDone(exh);
    const e = getExhibition(db, exh)!;
    expect(e.status).toBe("stage_failed");
    expect(e.failed_stage).toBe("narrative");
    expect(getRun(db, run_id)!.status).toBe("failed");
    expect(getNarrative(db, exh)).toBeNull();
  });
});
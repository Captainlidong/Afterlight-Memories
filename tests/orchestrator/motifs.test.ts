import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createDb } from "@/lib/db/client";
import { createExhibition, getExhibition, updateExhibition } from "@/lib/db/repos";
import { insertPhotoAsset, upsertInspection } from "@/lib/db/photos";
import { upsertAiDecision, setUserOverride } from "@/lib/db/curation";
import { listMotifs, selectMotif } from "@/lib/db/motifs";
import { getNarrative } from "@/lib/db/narrative";
import { getRun } from "@/lib/db/runs";
import { CreateExhibitionInput, PhotoInspection } from "@/lib/agents/schemas";
import { startPipeline, isRunning } from "@/lib/orchestrator/orchestrator";
import { prepareUpload } from "@/lib/image/pipeline";
import { uploadsDir, toRelative } from "@/lib/files";
import { newId } from "@/lib/id";
import { ApiError } from "@/lib/api/errors";
import type { DatabaseSync } from "node:sqlite";

let db: DatabaseSync;
let tmp: string;

/** motifs 门（§19.1）：只有确认过选片的影展才能进入主题发现。 */
function confirmedExh(mode: "demo" | "ai" = "demo"): string {
  const exh = createExhibition(db, CreateExhibitionInput.parse({}), mode).id;
  updateExhibition(db, exh, { selection_confirmed_revision: 1 });
  return exh;
}

async function addPhoto(exhId: string): Promise<string> {
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
  return id;
}

async function seedPhoto(
  exhId: string,
  opts: { tags?: string[]; subjects?: string[]; decision?: "keep" | "hold" | "remove"; override?: "must_keep" },
): Promise<string> {
  const id = await addPhoto(exhId);
  upsertInspection(db, PhotoInspection.parse({
    photo_id: id, sharpness_score: 0.7, laplacian_var: 100, brightness_score: 0.5,
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

async function waitDone(exhId: string, timeout = 8000): Promise<void> {
  const start = Date.now();
  while (isRunning(db, exhId)) {
    if (Date.now() - start > timeout) throw new Error("pipeline 超时");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-motifs-"));
  process.env.AFTERLIGHT_DATA_DIR = tmp;
  db = createDb(":memory:");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.AFTERLIGHT_DATA_DIR;
});

describe("motifs 管线（demo 启发式）", () => {
  it("仅保留照片参与 → 2–4 候选落库 + status awaiting_theme_choice", async () => {
    const exh = confirmedExh();
    const keepIds = [
      await seedPhoto(exh, { tags: ["框景"], subjects: ["窗"] }),
      await seedPhoto(exh, { tags: ["框景"], subjects: ["窗"] }),
      await seedPhoto(exh, { tags: ["背影"], subjects: ["人物背影"] }),
      await seedPhoto(exh, { tags: ["背影"], subjects: ["人物背影"] }),
    ];
    // hold / remove 照片不应进入主题输入。
    await seedPhoto(exh, { tags: ["框景"], decision: "hold" });
    await seedPhoto(exh, { tags: ["框景"], decision: "remove" });

    const { run_id } = startPipeline(db, exh, "motifs", "motifs");
    await waitDone(exh);
    expect(getExhibition(db, exh)!.status).toBe("awaiting_theme_choice");
    expect(getRun(db, run_id)!.status).toBe("completed");
    const motifs = listMotifs(db, exh);
    expect(motifs.length).toBeGreaterThanOrEqual(2);
    expect(motifs.length).toBeLessThanOrEqual(4);
    for (const m of motifs) {
      expect(m.state).toBe("proposed");
      expect(m.evidence.length).toBeGreaterThanOrEqual(1);
      for (const pid of m.photo_ids) expect(keepIds).toContain(pid);
    }
  });

  it("must_keep 照片纳入主题（即便 AI 判 remove）", async () => {
    const exh = confirmedExh();
    await seedPhoto(exh, {});
    const must = await seedPhoto(exh, { decision: "remove", override: "must_keep" });
    startPipeline(db, exh, "motifs", "motifs");
    await waitDone(exh);
    const motifs = listMotifs(db, exh);
    expect(motifs.length).toBeGreaterThanOrEqual(2);
    expect(motifs.some((m) => m.photo_ids.includes(must))).toBe(true);
  });

  it("无保留照片 → stage_failed motifs", async () => {
    const exh = confirmedExh();
    await seedPhoto(exh, { decision: "hold" });
    const { run_id } = startPipeline(db, exh, "motifs", "motifs");
    await waitDone(exh);
    const e = getExhibition(db, exh)!;
    expect(e.status).toBe("stage_failed");
    expect(e.failed_stage).toBe("motifs");
    expect(getRun(db, run_id)!.status).toBe("failed");
    expect(listMotifs(db, exh).length).toBe(0);
  });
});

describe("motifs 管线（ai 未配置）", () => {
  it("ai 模式 → stage_failed motifs，主题表为空", async () => {
    const exh = confirmedExh("ai");
    await seedPhoto(exh, {});
    const { run_id } = startPipeline(db, exh, "motifs", "motifs");
    await waitDone(exh);
    const e = getExhibition(db, exh)!;
    expect(e.status).toBe("stage_failed");
    expect(e.failed_stage).toBe("motifs");
    expect(getRun(db, run_id)!.status).toBe("failed");
    expect(listMotifs(db, exh).length).toBe(0);
  });
});

describe("叙事门（GATE before narrative）", () => {
  it("未选主题 → narrative 抛 409 theme_not_selected；选定后放行", async () => {
    const exh = confirmedExh();
    await seedPhoto(exh, { tags: ["框景"] });
    await seedPhoto(exh, { tags: ["框景"] });
    startPipeline(db, exh, "motifs", "motifs");
    await waitDone(exh);
    expect(getExhibition(db, exh)!.selected_motif_id).toBeNull();

    try { startPipeline(db, exh, "narrative", "narrative"); throw new Error("should throw"); }
    catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(409);
      expect((e as ApiError).code).toBe("theme_not_selected");
    }

    const motif = listMotifs(db, exh)[0];
    selectMotif(db, exh, motif.id);
    expect(getExhibition(db, exh)!.selected_motif_id).toBe(motif.id);
    // 门已开：narrative 已实现 → 放行并落库叙事。
    startPipeline(db, exh, "narrative", "narrative");
    await waitDone(exh);
    expect(getExhibition(db, exh)!.status).toBe("designing");
    expect(getNarrative(db, exh)).not.toBeNull();
  });
});
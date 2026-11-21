import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createDb } from "@/lib/db/client";
import { createExhibition, getExhibition } from "@/lib/db/repos";
import { insertPhotoAsset, upsertInspection } from "@/lib/db/photos";
import { getRun } from "@/lib/db/runs";
import { getDecision, setUserOverride } from "@/lib/db/curation";
import { CreateExhibitionInput, PhotoInspection } from "@/lib/agents/schemas";
import { startPipeline, isRunning } from "@/lib/orchestrator/orchestrator";
import { prepareUpload } from "@/lib/image/pipeline";
import { uploadsDir, toRelative } from "@/lib/files";
import { newId } from "@/lib/id";
import type { DatabaseSync } from "node:sqlite";

let db: DatabaseSync;
let tmp: string;

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

async function waitDone(exhId: string, timeout = 8000): Promise<void> {
  const start = Date.now();
  while (isRunning(db, exhId)) {
    if (Date.now() - start > timeout) throw new Error("pipeline 超时");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-select-"));
  process.env.AFTERLIGHT_DATA_DIR = tmp;
  db = createDb(":memory:");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.AFTERLIGHT_DATA_DIR;
});

describe("select 管线（demo）", () => {
  it("ingest→select → status awaiting_selection_confirm + 决定落库 + run completed", async () => {
    const exh = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    const photo = await addPhoto(exh);
    const { run_id } = startPipeline(db, exh, "ingest", "select");
    await waitDone(exh);
    expect(getExhibition(db, exh)!.status).toBe("awaiting_selection_confirm");
    // 最后一个 run 是 select（ingest 之后）。
    const d = getDecision(db, photo)!;
    expect(d).not.toBeNull();
    expect(["keep", "hold", "remove"]).toContain(d.ai_decision);
    expect(d.reasons.length).toBeGreaterThanOrEqual(1);
    expect(d.effective_decision).toBe(d.ai_decision);
    expect(getRun(db, run_id)!.status).toBe("completed");
  });

  it("must_keep 覆盖扛住 select 重跑（AI 不可覆盖用户必留）", async () => {
    const exh = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    const photo = await addPhoto(exh);
    startPipeline(db, exh, "ingest", "select");
    await waitDone(exh);
    setUserOverride(db, exh, photo, "must_keep", "必留");
    startPipeline(db, exh, "select", "select");
    await waitDone(exh);
    const d = getDecision(db, photo)!;
    expect(d.user_override).toBe("must_keep");
    expect(d.effective_decision).toBe("must_keep");
  });
});

describe("select 管线（ai 未配置）", () => {
  it("ai 模式 select → stage_failed + failed_stage select，前分析 intact", async () => {
    const exh = createExhibition(db, CreateExhibitionInput.parse({}), "ai").id;
    const photo = await addPhoto(exh);
    // 手动写入一条分析，模拟此前已成功的 ingest，使 select 有输入。
    upsertInspection(db, PhotoInspection.parse({
      photo_id: photo, sharpness_score: 0.7, laplacian_var: 100, brightness_score: 0.5,
      highlight_clip_ratio: 0.02, shadow_clip_ratio: 0.05, dominant_colors: ["#465a82"],
      color_temp: 0, saturation: 0.3, subjects: [], composition_tags: [],
      duplicate_group_id: null, processing_mode: "demo",
    }));
    const { run_id } = startPipeline(db, exh, "select", "select");
    await waitDone(exh);
    const e = getExhibition(db, exh)!;
    expect(e.status).toBe("stage_failed");
    expect(e.failed_stage).toBe("select");
    expect(getRun(db, run_id)!.status).toBe("failed");
    expect(getDecision(db, photo)).toBeNull();
  });
});
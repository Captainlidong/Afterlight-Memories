import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createDb } from "@/lib/db/client";
import { createExhibition, getExhibition } from "@/lib/db/repos";
import { insertPhotoAsset } from "@/lib/db/photos";
import { listRuns } from "@/lib/db/runs";
import { CreateExhibitionInput } from "@/lib/agents/schemas";
import { startPipeline, isRunning } from "@/lib/orchestrator/orchestrator";
import { demoStageDelayMs } from "@/lib/orchestrator/demoDelay";
import { prepareUpload } from "@/lib/image/pipeline";
import { uploadsDir, toRelative } from "@/lib/files";
import { newId } from "@/lib/id";
import type { DatabaseSync } from "node:sqlite";

describe("demoStageDelayMs（确定性演示延时）", () => {
  const demo = { id: "exh_abc", mode: "demo" as const };
  let prev: string | undefined;

  beforeAll(() => {
    prev = process.env.AFTERLIGHT_DEMO_DELAY;
    process.env.AFTERLIGHT_DEMO_DELAY = "1";
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.AFTERLIGHT_DEMO_DELAY;
    else process.env.AFTERLIGHT_DEMO_DELAY = prev;
  });

  it("select/motifs/narrative/layout/qa 落在 [500,1200]", () => {
    for (const s of ["select", "motifs", "narrative", "layout", "qa"] as const) {
      const ms = demoStageDelayMs(s, demo);
      expect(ms).toBeGreaterThanOrEqual(500);
      expect(ms).toBeLessThanOrEqual(1200);
    }
  });

  it("同一 (stage,id) 确定性：多次调用结果一致", () => {
    const a = demoStageDelayMs("narrative", demo);
    const b = demoStageDelayMs("narrative", demo);
    expect(a).toBe(b);
  });

  it("不同阶段通常产生不同延时（非全部相同）", () => {
    const vals = (["select", "motifs", "narrative", "layout", "qa"] as const).map((s) =>
      demoStageDelayMs(s, demo),
    );
    expect(new Set(vals).size).toBeGreaterThan(1);
  });

  it("ingest 不额外延时（真实 sharp 工作已耗时）", () => {
    expect(demoStageDelayMs("ingest", demo)).toBe(0);
  });

  it("ai 模式不延时", () => {
    expect(demoStageDelayMs("select", { id: "exh_ai", mode: "ai" })).toBe(0);
  });

  it("AFTERLIGHT_DEMO_DELAY=0 时全部关闭", () => {
    const prev = process.env.AFTERLIGHT_DEMO_DELAY;
    process.env.AFTERLIGHT_DEMO_DELAY = "0";
    try {
      expect(demoStageDelayMs("select", demo)).toBe(0);
      expect(demoStageDelayMs("qa", demo)).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.AFTERLIGHT_DEMO_DELAY;
      else process.env.AFTERLIGHT_DEMO_DELAY = prev;
    }
  });
});

describe("编排器接线演示延时", () => {
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
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-delay-"));
    process.env.AFTERLIGHT_DATA_DIR = tmp;
    db = createDb(":memory:");
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.AFTERLIGHT_DATA_DIR;
  });

  it("开启延时时 select 阶段 duration_ms ≥ 500（轨迹可见动画）", async () => {
    const prev = process.env.AFTERLIGHT_DEMO_DELAY;
    process.env.AFTERLIGHT_DEMO_DELAY = "1";
    try {
      const exh = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
      await addPhoto(exh);
      startPipeline(db, exh, "ingest", "select");
      await waitDone(exh);
      expect(getExhibition(db, exh)!.status).toBe("awaiting_selection_confirm");
      const selectRun = listRuns(db, exh).find((r) => r.agent_type === "aesthetic_selector")!;
      expect(selectRun.status).toBe("completed");
      expect(selectRun.duration_ms).toBeGreaterThanOrEqual(500);
    } finally {
      if (prev === undefined) delete process.env.AFTERLIGHT_DEMO_DELAY;
      else process.env.AFTERLIGHT_DEMO_DELAY = prev;
    }
  });
});
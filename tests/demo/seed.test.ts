import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb, getDb } from "@/lib/db/client";
import { getExhibition } from "@/lib/db/repos";
import { listPhotos, listInspections } from "@/lib/db/photos";
import { startPipeline } from "@/lib/orchestrator/orchestrator";
import { POST as seed } from "@/app/api/demo/seed/route";
import { DEMO_COUNT } from "@/lib/demo/manifest";
import type { DatabaseSync } from "node:sqlite";

let db: DatabaseSync;
let tmp: string;

async function waitDone(id: string, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const exh = getExhibition(db, id)!;
    if (exh.status !== "ingesting" && exh.status !== "draft") return exh;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("ingest 超时");
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-seed-"));
  process.env.AFTERLIGHT_DATA_DIR = tmp;
  (globalThis as unknown as { __afterlightDb?: unknown }).__afterlightDb = createDb(":memory:");
  db = getDb();
});

afterAll(() => {
  delete (globalThis as unknown as { __afterlightDb?: unknown }).__afterlightDb;
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.AFTERLIGHT_DATA_DIR;
});

describe("demo seed → ingest 端到端", () => {
  it("24 张示例图分析完成，命中预设，近重复成组", async () => {
    const res = await seed();
    expect(res.status).toBe(201);
    const { id } = await res.json();
    expect(listPhotos(db, id).length).toBe(DEMO_COUNT);

    startPipeline(db, id, "ingest", "ingest");
    const exh = await waitDone(id);
    expect(exh.status).not.toBe("stage_failed");

    const inspections = listInspections(db, id);
    expect(inspections.length).toBe(DEMO_COUNT);
    // 全部命中 manifest → demo 模式（真实指标 + 预设语义标签）。
    expect(inspections.every((i) => i.processing_mode === "demo")).toBe(true);
    expect(inspections.every((i) => i.subjects.length > 0)).toBe(true);

    // p20/p21 重压近重复应同组（真实 pHash hamming≤10）。
    const photos = listPhotos(db, id);
    const p20 = photos.find((p) => p.original_name === "空椅窗边.jpg")!;
    const p21 = photos.find((p) => p.original_name === "空椅窗边-2.jpg")!;
    const ins20 = inspections.find((i) => i.photo_id === p20.id)!;
    const ins21 = inspections.find((i) => i.photo_id === p21.id)!;
    expect(ins20.duplicate_group_id).not.toBeNull();
    expect(ins20.duplicate_group_id).toBe(ins21.duplicate_group_id);

    // 连续两次 seed 不碰撞（全新 id）。
    const res2 = await seed();
    const { id: id2 } = await res2.json();
    expect(id2).not.toBe(id);
  }, 60000);
});
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { runSelect } from "@/lib/agents/aestheticSelector";
import { bumpInputRevision, updateExhibition } from "@/lib/db/repos";
import { updateRun } from "@/lib/db/runs";
import { startPipelineOnce, type StageContext } from "@/lib/orchestrator/orchestrator";
import { ensureExecutionOwner } from "@/lib/orchestrator/recovery";

vi.mock("@/lib/agents/aestheticSelector", () => ({ runSelect: vi.fn() }));
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createDb } from "@/lib/db/client";
import { createExhibition, getExhibition } from "@/lib/db/repos";
import { insertPhotoAsset, getPhoto, getInspection } from "@/lib/db/photos";
import { createRun, getRun } from "@/lib/db/runs";
import { CreateExhibitionInput } from "@/lib/agents/schemas";
import { startPipeline, isRunning } from "@/lib/orchestrator/orchestrator";
import { prepareUpload } from "@/lib/image/pipeline";
import { uploadsDir, toRelative } from "@/lib/files";
import { newId } from "@/lib/id";
import { ApiError, ConcurrentRunError } from "@/lib/api/errors";
import type { DatabaseSync } from "node:sqlite";

let db: DatabaseSync;
let tmp: string;
let exhDemo: string;
let exhAi: string;
let photoDemo: string;
let photoAi: string;

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

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-orch-"));
  process.env.AFTERLIGHT_DATA_DIR = tmp;
  db = createDb(":memory:");
  exhDemo = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
  exhAi = createExhibition(db, CreateExhibitionInput.parse({}), "ai").id;
  photoDemo = await addPhoto(exhDemo);
  photoAi = await addPhoto(exhAi);
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.AFTERLIGHT_DATA_DIR;
});

describe("orchestrator guards", () => {
  it("非法阶段范围 → 400", () => {
    expect(() => startPipeline(db, exhDemo, "qa", "ingest")).toThrow(ApiError);
    try { startPipeline(db, exhDemo, "qa", "ingest"); } catch (e) {
      expect((e as ApiError).status).toBe(400);
    }
  });

  it("qa 已注册：narrative→qa 不再 501（未选主线时先撞叙事门 409）", () => {
    try { startPipeline(db, exhDemo, "narrative", "qa"); throw new Error("should throw"); }
    catch (e) {
      expect((e as ApiError).status).toBe(409);
      expect((e as ApiError).code).toBe("theme_not_selected");
    }
  });

  it("已有运行中任务 → 409", () => {
    const exh = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    createRun(db, { exhibitionId: exh, agentType: "material_steward", status: "running", inputVersion: 0 });
    expect(() => startPipeline(db, exh, "ingest", "ingest")).toThrow(ConcurrentRunError);
  });

  it("影展不存在 → 404", () => {
    try { startPipeline(db, "exh_nope", "ingest", "ingest"); throw new Error("should throw"); }
    catch (e) { expect((e as ApiError).status).toBe(404); }
  });
});

describe("S09 stage publication fencing", () => {
  const invalidations = ["revision", "run", "expiry", "owner", "workflow"] as const;
  it.each(invalidations)("agent 发布 guard 拒绝 %s 失效", async (kind) => {
    const id = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    const entered = Promise.withResolvers<StageContext>();
    const resume = Promise.withResolvers<void>();
    let guardError: unknown;
    vi.mocked(runSelect).mockImplementationOnce(async (conn, ctx) => {
      entered.resolve(ctx as StageContext);
      await resume.promise;
      conn.exec("BEGIN IMMEDIATE");
      try {
        ctx.assertOwner!();
        updateExhibition(conn, id, { title: "OLD RESULT" });
        conn.exec("COMMIT");
      } catch (error) {
        guardError = error;
        conn.exec("ROLLBACK");
        throw error;
      }
      return {} as never;
    });
    const { run_id } = startPipeline(db, id, "select", "select");
    await entered.promise;
    updateExhibition(db, id, { title: "new input", status: "awaiting_user_review", failed_stage: null });
    if (kind === "revision") bumpInputRevision(db, id);
    if (kind === "run") updateRun(db, run_id, { status: "failed", error_message: "new owner already settled" });
    if (kind === "expiry") db.prepare("UPDATE task_leases SET expires_at=? WHERE exhibition_id=?").run(new Date(0).toISOString(), id);
    if (kind === "owner") db.prepare("UPDATE task_leases SET owner_id='other' WHERE exhibition_id=?").run(id);
    if (kind === "workflow") db.prepare("UPDATE task_leases SET workflow_id='other' WHERE exhibition_id=?").run(id);
    resume.resolve();
    await waitDone(id);
    expect(guardError).toMatchObject({ code: "run_fenced" });
    if (kind === "revision") expect(guardError).toMatchObject({ details: { cause: "stale_input" } });
    expect(getExhibition(db, id)).toMatchObject({ title: "new input", status: "awaiting_user_review", failed_stage: null });
    expect(getRun(db, run_id)!.status).toBe("failed");
    if (kind === "run") expect(getRun(db, run_id)!.error_message).toBe("new owner already settled");
    db.prepare("DELETE FROM task_leases WHERE exhibition_id=?").run(id);
  });

  it.each(["success", "ordinary_error"])("阶段返回 %s 后也重检 revision，不覆盖新状态", async (outcome) => {
    const id = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    vi.mocked(runSelect).mockImplementationOnce(async () => {
      bumpInputRevision(db, id);
      updateExhibition(db, id, { status: "awaiting_user_review", title: "new input" });
      if (outcome === "ordinary_error") throw new Error("late provider error");
      return {} as never;
    });
    const { run_id } = startPipeline(db, id, "select", "select");
    await waitDone(id);
    expect(getExhibition(db, id)).toMatchObject({ status: "awaiting_user_review", title: "new input", failed_stage: null });
    expect(getRun(db, run_id)!).toMatchObject({ status: "failed", output_json: null });
    expect(getRun(db, run_id)!.error_message).toContain("stale_input");
  });

  it("run、lease、预留属于同一事务；预留失败不留下 lease/心跳", () => {
    const id = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    expect(() => startPipelineOnce(db, id, "select", "select", "failed-reserve", {
      reserve: (_conn, ids) => {
        expect(db.isTransaction).toBe(true);
        expect(ensureExecutionOwner(db, id, ids.workflowId)).toBe(true);
        throw new Error("reserve failed");
      },
    })).toThrow("reserve failed");
    expect(db.prepare("SELECT * FROM agent_runs WHERE exhibition_id=?").all(id)).toEqual([]);
    expect(db.prepare("SELECT * FROM task_leases WHERE exhibition_id=?").all(id)).toEqual([]);
    expect(isRunning(db, id)).toBe(false);
  });
});

describe("orchestrator pipeline", () => {
  it("ingest 成功 → status selecting + run completed + 分析落库", async () => {
    const { run_id } = startPipeline(db, exhDemo, "ingest", "ingest");
    await waitDone(exhDemo);
    expect(getExhibition(db, exhDemo)!.status).toBe("selecting");
    const run = getRun(db, run_id)!;
    expect(run.status).toBe("completed");
    expect(run.duration_ms).toBeGreaterThanOrEqual(0);
    expect(getInspection(db, photoDemo)).not.toBeNull();
    expect(getPhoto(db, photoDemo)!.status).toBe("inspected");
  });

  it("AI 模式失败 → stage_failed，照片行不被污染，前结果 intact", async () => {
    const { run_id } = startPipeline(db, exhAi, "ingest", "ingest");
    await waitDone(exhAi);
    const exh = getExhibition(db, exhAi)!;
    expect(exh.status).toBe("stage_failed");
    expect(exh.failed_stage).toBe("ingest");
    expect(getRun(db, run_id)!.status).toBe("failed");
    expect(getRun(db, run_id)!.error_message).toBeTruthy();
    // 系统性适配器错误：照片保持 uploaded，未标 failed，未写分析
    expect(getPhoto(db, photoAi)!.status).toBe("uploaded");
    expect(getInspection(db, photoAi)).toBeNull();
  });
});
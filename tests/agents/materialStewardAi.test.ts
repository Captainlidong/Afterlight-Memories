import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { createDb } from "@/lib/db/client";
import { createExhibition, getExhibition } from "@/lib/db/repos";
import { getInspection, getPhoto, insertPhotoAsset, updatePhoto } from "@/lib/db/photos";
import { CreateExhibitionInput } from "@/lib/agents/schemas";
import { runIngest } from "@/lib/agents/materialSteward";
import { prepareUpload } from "@/lib/image/pipeline";
import { toRelative, uploadsDir } from "@/lib/files";
import { listAiCalls } from "@/lib/ai/records";
import { createRun, getRun, updateRun } from "@/lib/db/runs";
import { getBudgetUsage } from "@/lib/ai/budget";
import { getCurationJob } from "@/lib/db/curationJobs";
import { AI_ENV_DEFAULTS, loadAiConfig } from "@/lib/ai/config";
import { AiClient } from "@/lib/ai/client";
import { ApiError } from "@/lib/api/errors";
import { AiError, type AiErrorClass } from "@/lib/ai/errors";
import * as adapters from "@/lib/adapters";

const FACTS = {
  summary: "窗边的背影。",
  subjects: ["窗", "人物背影"],
  composition_tags: ["框景"],
  light_tags: ["侧光"],
  spatial_relations: ["人物靠近窗边"],
  evidence: [{ kind: "observation", text: "人物背对镜头" }],
  uncertainties: [],
};

function modelResponse(payload: unknown = FACTS): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    { status: 200 },
  );
}

describe("materialSteward AI 混合照片（V05/V07/V08）", () => {
  let db: DatabaseSync;
  let tmp: string;
  let exhibitionId: string;
  const originals = new Map<string, Buffer>();

  beforeEach(() => {
    originals.clear();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-ai-ingest-"));
    vi.stubEnv("AFTERLIGHT_DATA_DIR", tmp);
    for (const [key, value] of Object.entries(AI_ENV_DEFAULTS)) {
      vi.stubEnv(key, String(value));
    }
    vi.stubEnv("AI_PROVIDER", "openai-compatible");
    vi.stubEnv("AI_TEXT_MODEL", "text-test");
    vi.stubEnv("AFTERLIGHT_ACCESS_MODE", "local");
    vi.stubEnv("RATE_LIMIT_ENABLED", "true");
    vi.stubEnv("RATE_LIMIT_TASKS_PER_IP_PER_MINUTE", "2");
    vi.stubEnv("RATE_LIMIT_TASKS_PER_IP_PER_DAY", "5");
    vi.stubEnv("RATE_LIMIT_TASKS_PER_USER_PER_DAY", "5");
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("Unexpected test transport call");
    }));
    vi.stubEnv("AI_API_KEY", "sk-test-only-123456");
    vi.stubEnv("AI_BASE_URL", "https://api.example.com/v1");
    vi.stubEnv("AI_VISION_MODEL", "vision-x");
    vi.stubEnv("AI_MAX_RETRIES", "0");
    vi.stubEnv("AFTERLIGHT_DEMO_DELAY", "0");
    db = createDb(":memory:");
    exhibitionId = createExhibition(
      db,
      CreateExhibitionInput.parse({ allow_external_ai: true }),
      "ai",
    ).id;
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function addPhoto(id: string, buffer: Buffer, order: number) {
    const prepared = id === "photo_bad"
      ? { width: null, height: null }
      : await prepareUpload(buffer);
    const dir = uploadsDir(exhibitionId);
    fs.mkdirSync(dir, { recursive: true });
    const absolute = path.join(dir, `${id}.jpg`);
    fs.writeFileSync(absolute, buffer);
    originals.set(id, buffer);
    insertPhotoAsset(db, {
      id,
      exhibition_id: exhibitionId,
      original_name: `${id}.jpg`,
      storage_path: toRelative(absolute),
      thumbnail_path: null,
      width: prepared.width,
      height: prepared.height,
      mime_type: "image/jpeg",
      file_size: buffer.length,
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      sort_order: order,
    });
  }

  function context(runId = "run_ai") {
    return { runId, workflowId: "wf_ai", exhibition: getExhibition(db, exhibitionId)! };
  }

  async function image() {
    return sharp({
      create: { width: 100, height: 80, channels: 3, background: { r: 40, g: 70, b: 110 } },
    }).jpeg().toBuffer();
  }

  it("persists current-run progress and never counts historical inspections as current completion", async () => {
    const bytes = await image();
    await addPhoto("photo_progress", bytes, 0);
    const transport = vi.fn(async () => modelResponse());
    vi.stubGlobal("fetch", transport);
    const run = createRun(db, { exhibitionId, agentType: "material_steward", inputVersion: 0, status: "running", workflowId: "progress" });
    await runIngest(db, { ...context(run.id), workflowId: "progress" });
    expect(getRun(db, run.id)!.output_json).toMatchObject({ total: 1, processed: 1, reused: 0, newly_completed: 1, failed: 0, pending: 0 });
    const retry = createRun(db, { exhibitionId, agentType: "material_steward", inputVersion: 0, status: "running", workflowId: "progress-retry" });
    await runIngest(db, { ...context(retry.id), workflowId: "progress-retry" });
    expect(getRun(db, retry.id)!.output_json).toMatchObject({ total: 1, processed: 1, reused: 1, newly_completed: 0, failed: 0, pending: 0 });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("29/30 recovery across database reopen sends only the missing photo and keeps 31 charged attempts", async () => {
    db.close();
    const dbFile = path.join(tmp, "resume.db");
    db = createDb(dbFile);
    exhibitionId = createExhibition(db, CreateExhibitionInput.parse({ allow_external_ai: true }), "ai").id;
    for (let i = 0; i < 30; i++) {
      const bytes = await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: i * 7, g: 80, b: 160 } } }).jpeg().toBuffer();
      await addPhoto(`resume_${i}`, bytes, i);
    }
    let calls = 0;
    const transport = vi.fn(async () => ++calls === 30 ? modelResponse({ invalid: true }) : modelResponse());
    vi.stubGlobal("fetch", transport);
    const first = createRun(db, { exhibitionId, agentType: "material_steward", inputVersion: 0, status: "running", workflowId: "wf_first" });
    await expect(runIngest(db, { ...context(first.id), workflowId: "wf_first" })).rejects.toMatchObject({ code: "vision_incomplete" });
    expect(transport).toHaveBeenCalledTimes(30);
    expect(getRun(db, first.id)!.output_json).toMatchObject({ processed: 29, failed: 1 });
    updateRun(db, first.id, { status: "failed" });
    const originalCall = listAiCalls(db, { exhibitionId }).find(c => c.status === "succeeded")!.id;
    db.close();
    db = createDb(dbFile);
    const second = createRun(db, { exhibitionId, agentType: "material_steward", inputVersion: 0, status: "running", workflowId: "wf_second" });
    const output = await runIngest(db, { ...context(second.id), workflowId: "wf_second" });
    expect(output).toMatchObject({ total: 30, processed: 30, reused: 29, newly_completed: 1, failed: 0, pending: 0 });
    expect(output.photo_results.every(p => p.call_id !== null)).toBe(true);
    expect(JSON.stringify(getRun(db, second.id)!.output_json)).toContain(originalCall);
    expect(transport).toHaveBeenCalledTimes(31);
    expect(listAiCalls(db, { exhibitionId, scopeId: "wf_second" })).toHaveLength(1);
    expect(getBudgetUsage(db, { scopeType: "job", scopeId: getCurationJob(db, exhibitionId)!.id, periodKey: "total" })).toBe(31);
  });

  it("publishes inspection and its progress only after checking ownership inside the transaction", async () => {
    await addPhoto("photo_guard", await image(), 0);
    vi.stubGlobal("fetch", vi.fn(async () => modelResponse()));
    let checkedInTransaction = false;
    const assertOwner = () => { if (db.isTransaction) checkedInTransaction = true; };
    await runIngest(db, { ...context(), assertOwner });
    expect(checkedInTransaction).toBe(true);
  });

  it("editing title or tone and adding one photo reuse unchanged image facts with current-run progress", async () => {
    await addPhoto("unchanged_a", await image(), 0);
    const other = await sharp({ create: { width: 100, height: 80, channels: 3, background: { r: 180, g: 90, b: 30 } } }).jpeg().toBuffer();
    await addPhoto("unchanged_b", other, 1);
    const transport = vi.fn(async () => modelResponse());
    vi.stubGlobal("fetch", transport);
    await runIngest(db, context());
    expect(transport).toHaveBeenCalledTimes(2);
    db.prepare("UPDATE exhibitions SET title=?,tone=?,input_revision=input_revision+1 WHERE id=?")
      .run("作者更新的标题", "poetic", exhibitionId);
    expect(await runIngest(db, { ...context("run_edit_only"), workflowId: "wf_edit_only" }))
      .toMatchObject({ processed: 2, reused: 2, newly_completed: 0 });
    expect(transport).toHaveBeenCalledTimes(2);
    const third = await sharp({ create: { width: 100, height: 80, channels: 3, background: { r: 20, g: 180, b: 60 } } }).jpeg().toBuffer();
    await addPhoto("new_photo", third, 2);
    db.prepare("UPDATE exhibitions SET input_revision=input_revision+1 WHERE id=?").run(exhibitionId);
    const result = await runIngest(db, { ...context("run_added"), workflowId: "wf_added" });
    expect(result).toMatchObject({ total: 3, processed: 3, reused: 2, newly_completed: 1 });
    expect(transport).toHaveBeenCalledTimes(3);
    expect(listAiCalls(db, { scopeId: "wf_added" })).toHaveLength(1);
  });

  it("does not translate unrelated task API failures into stale context", async () => {
    const error = new ApiError(409, "unrelated_guard_error", "Other validation failed");
    await expect(runIngest(db, { ...context(), assertOwner: () => { throw error; } })).rejects.toBe(error);
    expect(fetch).not.toHaveBeenCalled();
    expect(listAiCalls(db)).toHaveLength(0);
  });

  it("persists the first completion while the next model promise is unresolved", async () => {
    vi.stubEnv("AI_CACHE_ENABLED", "false");
    const bytes = await image();
    await addPhoto("photo_first", bytes, 0);
    await addPhoto("photo_second", bytes, 1);
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    let signalStarted!: () => void;
    const secondStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const transport = vi.fn()
      .mockImplementationOnce(async () => modelResponse())
      .mockImplementationOnce(() => {
        signalStarted();
        return pending;
      });
    vi.stubGlobal("fetch", transport);
    const ingest = runIngest(db, context());
    try {
      await secondStarted;
      expect(getPhoto(db, "photo_first")!.status).toBe("inspected");
      expect(getInspection(db, "photo_first")).toMatchObject({ visual_facts: FACTS });
      expect(getPhoto(db, "photo_second")!.status).toBe("uploaded");
      expect(getInspection(db, "photo_second")).toBeNull();
      expect(db.isTransaction).toBe(false);
    } finally {
      release(modelResponse());
      await ingest;
    }
    const group = getInspection(db, "photo_first")!.duplicate_group_id;
    expect(group).not.toBeNull();
    expect(getInspection(db, "photo_second")!.duplicate_group_id).toBe(group);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("retries a failed model photo on an explicit ingest rerun", async () => {
    const bytes = await image();
    await addPhoto("photo_retry", bytes, 0);
    const transport = vi.fn()
      .mockImplementationOnce(async () => modelResponse({ invalid: true }))
      .mockImplementationOnce(async () => modelResponse());
    vi.stubGlobal("fetch", transport);
    await expect(runIngest(db, context())).rejects.toMatchObject({ code: "vision_incomplete" });
    expect(getPhoto(db, "photo_retry")!.status).toBe("failed");
    expect(getInspection(db, "photo_retry")).toBeNull();
    expect(transport).toHaveBeenCalledTimes(1);

    await expect(runIngest(db, context("run_retry"))).resolves.toMatchObject({
      processed: 1, failed: 0, inspected_photo_ids: ["photo_retry"],
    });
    expect(getPhoto(db, "photo_retry")).toMatchObject({ status: "inspected", error_message: null });
    expect(getInspection(db, "photo_retry")).toMatchObject({ visual_facts: FACTS });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(path.join(uploadsDir(exhibitionId), "photo_retry.jpg"))).toEqual(bytes);
  });

  it.each(["success", "failure"])("fences a later %s without losing the committed prefix or marking it failed", async (outcome) => {
    vi.stubEnv("AI_CACHE_ENABLED", "false");
    const bytes = await image();
    await addPhoto("photo_first", bytes, 0);
    await addPhoto("photo_second", bytes, 1);
    await addPhoto("photo_third", bytes, 2);
    let fenced = false;
    const transport = vi.fn()
      .mockImplementationOnce(async () => modelResponse())
      .mockImplementationOnce(async () => {
        fenced = true;
        return modelResponse(outcome === "success" ? FACTS : { invalid: true });
      });
    vi.stubGlobal("fetch", transport);
    const ownerError = new ApiError(409, "run_fenced", "Execution owner changed");
    const assertOwner = vi.fn(() => {
      if (fenced) {
        // One-shot throw also detects accidentally swallowing/rechecking the owner error.
        fenced = false;
        throw ownerError;
      }
    });
    await expect(runIngest(db, { ...context(), assertOwner })).rejects.toMatchObject({ cls: "stale_context" });
    expect(getPhoto(db, "photo_first")!.status).toBe("inspected");
    expect(getInspection(db, "photo_first")).toMatchObject({ visual_facts: FACTS });
    for (const id of ["photo_second", "photo_third"]) {
      expect(getPhoto(db, id)).toMatchObject({ status: "uploaded", error_message: null });
      expect(getInspection(db, id)).toBeNull();
    }
    expect(transport).toHaveBeenCalledTimes(2);
    expect(db.isTransaction).toBe(false);
  });

  it.each(["owner", "configuration"])("queued ingest rechecks current %s before sending and preserves progress", async (kind) => {
    await addPhoto("photo_queued", await image(), 0);
    vi.stubEnv("AI_MAX_CONCURRENCY", "1");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const blockerTransport = vi.fn(async () => { await gate; return modelResponse(); });
    const blocker = new AiClient(db, loadAiConfig(), blockerTransport).run({
      context: { purpose: "connection_test", scopeType: "connection_test", scopeId: "probe-blocker",
        exhibitionId: null, promptVersion: "p", schemaVersion: "s" },
      model: "vision-x", messages: [{ role: "user", content: "synthetic probe" }],
      maxTokens: 100, parse: JSON.parse,
    });
    let active = true;
    let checks = 0;
    const assertOwner = () => {
      checks++;
      if (!active) throw new ApiError(409, "run_fenced", "Execution owner changed");
    };
    const run = createRun(db, { exhibitionId, agentType: "material_steward", inputVersion: 0, status: "running", workflowId: "queued" });
    const ingest = runIngest(db, { ...context(run.id), workflowId: "queued", assertOwner });
    // Initial ownership + initial progress + client policy means analysis reached the queue.
    await vi.waitFor(() => expect(checks).toBeGreaterThanOrEqual(3));
    const rejected = expect(ingest).rejects.toMatchObject({ cls: kind === "owner" ? "stale_context" : "config" });
    if (kind === "owner") active = false;
    else vi.stubEnv("AI_API_KEY", "sk-test-changed-only");
    release();
    await blocker;
    await rejected;
    expect(fetch).not.toHaveBeenCalled();
    expect(getInspection(db, "photo_queued")).toBeNull();
    expect(getPhoto(db, "photo_queued")).toMatchObject({ status: "uploaded", error_message: null });
    expect(getRun(db, run.id)!.output_json).toMatchObject({ processed: 0, reused: 0, newly_completed: 0 });
    expect(listAiCalls(db)).toHaveLength(1);
    expect(db.isTransaction).toBe(false);
  });

  it.each<AiErrorClass>(["config", "unauthorized", "budget", "auth", "quota"])(
    "stops at fatal %s and finalizes duplicates for the successful prefix",
    async (cls) => {
      const bytes = await image();
      for (let i = 0; i < 4; i++) await addPhoto(`photo_${i}`, bytes, i);
      const fatalError = new AiError(cls, "Stop external calls");
      const desc = {
        subjects: FACTS.subjects,
        composition_tags: FACTS.composition_tags,
        visual_embedding: null,
        processing_mode: "ai" as const,
      };
      const describePhoto = vi.fn()
        .mockResolvedValueOnce(desc)
        .mockResolvedValueOnce(desc)
        .mockRejectedValueOnce(fatalError);
      vi.spyOn(adapters, "getVisionAdapter").mockReturnValue({ describePhoto });
      await expect(runIngest(db, context())).rejects.toBe(fatalError);
      expect(describePhoto).toHaveBeenCalledTimes(3);
      expect(fetch).not.toHaveBeenCalled();
      const group = getInspection(db, "photo_0")!.duplicate_group_id;
      expect(group).not.toBeNull();
      expect(getInspection(db, "photo_1")!.duplicate_group_id).toBe(group);
      for (const id of ["photo_0", "photo_1"]) {
        expect(getPhoto(db, id)!.status).toBe("inspected");
      }
      for (const id of ["photo_2", "photo_3"]) {
        expect(getPhoto(db, id)).toMatchObject({ status: "uploaded", error_message: null });
        expect(getInspection(db, id)).toBeNull();
      }
    },
  );

  it("revisits successful photos and preserves their inspection when a new AI attempt fails", async () => {
    vi.stubEnv("AI_CACHE_ENABLED", "false");
    const bytes = await image();
    await addPhoto("photo_existing", bytes, 0);
    const transport = vi.fn()
      .mockImplementationOnce(async () => modelResponse())
      .mockImplementationOnce(async () => modelResponse({ invalid: true }));
    vi.stubGlobal("fetch", transport);
    await runIngest(db, context());
    const saved = getInspection(db, "photo_existing");
    await expect(runIngest(db, context("run_retry"))).rejects.toMatchObject({
      code: "vision_incomplete",
      message: expect.stringContaining("成功结果已保存，请重试失败项"),
    });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(getPhoto(db, "photo_existing")!.status).toBe("failed");
    expect(getInspection(db, "photo_existing")).toEqual(saved);
    expect(fs.readFileSync(path.join(uploadsDir(exhibitionId), "photo_existing.jpg"))).toEqual(bytes);
  });

  it("retries a file-read failure once the original bytes are available again", async () => {
    const bytes = await image();
    await addPhoto("photo_file", bytes, 0);
    const file = path.join(uploadsDir(exhibitionId), "photo_file.jpg");
    fs.unlinkSync(file);
    const transport = vi.fn(async () => modelResponse());
    vi.stubGlobal("fetch", transport);
    await expect(runIngest(db, context())).rejects.toMatchObject({ code: "vision_incomplete" });
    expect(getPhoto(db, "photo_file")!.status).toBe("failed");
    expect(transport).not.toHaveBeenCalled();
    fs.writeFileSync(file, bytes);
    await expect(runIngest(db, context("run_retry"))).resolves.toMatchObject({ processed: 1, failed: 0 });
    expect(getPhoto(db, "photo_file")).toMatchObject({ status: "inspected", error_message: null });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(file)).toEqual(bytes);
  });

  it("rechecks unchanged corrupt bytes and reports an honest new failure without model calls", async () => {
    const bytes = Buffer.from("still not an image");
    await addPhoto("photo_bad", bytes, 0);
    await expect(runIngest(db, context())).rejects.toMatchObject({ code: "vision_incomplete" });
    const firstError = getPhoto(db, "photo_bad")!.error_message;
    expect(firstError).toBeTruthy();
    updatePhoto(db, "photo_bad", { error_message: "previous attempt" });
    await expect(runIngest(db, context("run_retry"))).rejects.toMatchObject({ code: "vision_incomplete" });
    expect(getPhoto(db, "photo_bad")).toMatchObject({ status: "failed", error_message: firstError });
    expect(getInspection(db, "photo_bad")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(uploadsDir(exhibitionId), "photo_bad.jpg"))).toEqual(bytes);
  });

  it("rolls back only the current photo if its status write fails", async () => {
    vi.stubEnv("AI_CACHE_ENABLED", "false");
    const bytes = await image();
    await addPhoto("photo_first", bytes, 0);
    await addPhoto("photo_second", bytes, 1);
    db.exec(`CREATE TRIGGER reject_inspected BEFORE UPDATE OF status ON photo_assets
      WHEN NEW.id = 'photo_second' AND NEW.status = 'inspected'
      BEGIN SELECT RAISE(ABORT, 'test status write failure'); END;`);
    vi.stubGlobal("fetch", vi.fn(async () => modelResponse()));
    await expect(runIngest(db, context())).rejects.toThrow("test status write failure");
    expect(getPhoto(db, "photo_first")!.status).toBe("inspected");
    expect(getInspection(db, "photo_first")).toMatchObject({ visual_facts: FACTS });
    expect(getPhoto(db, "photo_second")).toMatchObject({ status: "uploaded", error_message: null });
    expect(getInspection(db, "photo_second")).toBeNull();
    expect(db.isTransaction).toBe(false);
  });

  it("坏图隔离且单张模型失败不回滚同批成功事实，整批明确失败而非假完成", async () => {
    const good = await sharp({
      create: { width: 100, height: 80, channels: 3, background: { r: 40, g: 70, b: 110 } },
    }).jpeg().toBuffer();
    await addPhoto("photo_good_1", good, 0);
    await addPhoto("photo_bad", Buffer.from("broken image"), 1);
    const second = await sharp({
      create: { width: 100, height: 80, channels: 3, background: { r: 110, g: 70, b: 40 } },
    }).jpeg().toBuffer();
    await addPhoto("photo_good_2", second, 2);
    let requestCount = 0;
    const transport = vi.fn(async () => {
      requestCount++;
      return requestCount === 2 ? modelResponse({ invalid: true }) : modelResponse();
    });
    vi.stubGlobal("fetch", transport);

    await expect(runIngest(db, {
      runId: "run_ai",
      workflowId: "wf_ai",
      exhibition: getExhibition(db, exhibitionId)!,
    })).rejects.toMatchObject({ code: "vision_incomplete" });

    const saved = getInspection(db, "photo_good_1")!;
    expect(saved.visual_facts).toEqual(FACTS);
    expect(saved.visual_source).toBe("fresh");
    expect(saved.analysis_image_sha256).toHaveLength(64);
    expect(getPhoto(db, "photo_good_1")!.status).toBe("inspected");
    expect(getPhoto(db, "photo_bad")!.status).toBe("failed");
    expect(getPhoto(db, "photo_bad")!.error_message).toBeTruthy();
    expect(getPhoto(db, "photo_good_2")!.status).toBe("failed");
    expect(getPhoto(db, "photo_good_2")!.error_message).toContain("结构化结果");
    expect(getInspection(db, "photo_good_2")).toBeNull();
    expect(transport).toHaveBeenCalledTimes(2);
    expect(listAiCalls(db, { scopeId: "wf_ai" }).map((c) => c.status).sort()).toEqual([
      "failed",
      "succeeded",
    ]);
    for (const [id, original] of originals) {
      expect(fs.readFileSync(path.join(uploadsDir(exhibitionId), `${id}.jpg`)).equals(original)).toBe(true);
    }
  });
});

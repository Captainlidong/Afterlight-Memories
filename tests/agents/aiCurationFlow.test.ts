import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createDb } from "@/lib/db/client";
import { createExhibition, getExhibition, updateExhibition, bumpInputRevision } from "@/lib/db/repos";
import { insertPhotoAsset, listInspections } from "@/lib/db/photos";
import { getDecision, listDecisions, setUserOverride } from "@/lib/db/curation";
import { listMotifs, selectMotif, updateMotif } from "@/lib/db/motifs";
import { getNarrative } from "@/lib/db/narrative";
import { getLayout } from "@/lib/db/layout";
import { listEdits, upsertEdit } from "@/lib/db/edits";
import { listVersions } from "@/lib/db/versions";
import { getRun } from "@/lib/db/runs";
import { CreateExhibitionInput } from "@/lib/agents/schemas";
import { startPipeline, startPipelineOnce, isRunning } from "@/lib/orchestrator/orchestrator";
import { runNarrative } from "@/lib/agents/narrativeEditor";
import { listAiCalls } from "@/lib/ai/records";
import { loadAiConfig } from "@/lib/ai/config";
import { runAiConnectionTest } from "@/lib/ai/connectionTest";
import { getBudgetUsage } from "@/lib/ai/budget";
import { uploadsDir, toRelative } from "@/lib/files";
import { createHash } from "node:crypto";

const facts = { summary: "墙面与侧光", subjects: ["墙面"], composition_tags: ["留白"], light_tags: ["侧光"], spatial_relations: [], evidence: [{ kind: "observation", text: "侧光照亮墙面" }], uncertainties: [] };
const respond = (payload: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 });

describe("真实四 adapter 与编排器端到端 / Mock", () => {
  let db: DatabaseSync, exhibitionId: string, tmp: string;
  let invalid: "curation" | "narrative" | "chapter" | null;
  let removeThird: boolean;
  let emptyMotifs: boolean;
  let transport: ReturnType<typeof vi.fn<typeof fetch>>;
  const ids = ["p1", "p2", "p3"];
  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-ai-flow-"));
    vi.stubEnv("AFTERLIGHT_DATA_DIR", tmp);
    vi.stubEnv("AI_API_KEY", "mock-only"); vi.stubEnv("AI_BASE_URL", "https://api.example.com/v1");
    vi.stubEnv("AI_VISION_MODEL", "vision-test"); vi.stubEnv("AI_TEXT_MODEL", "text-test"); vi.stubEnv("AI_MAX_RETRIES", "0");
    db = createDb(":memory:");
    exhibitionId = createExhibition(db, CreateExhibitionInput.parse({ allow_external_ai: true }), "ai").id;
    const dir = uploadsDir(exhibitionId); fs.mkdirSync(dir, { recursive: true });
    for (const [i, id] of ids.entries()) {
      const bytes = await sharp({ create: { width: 100, height: 80, channels: 3, background: { r: 30 + i * 60, g: 80, b: 130 } } }).jpeg().toBuffer();
      const original = path.join(dir, `${id}.jpg`); fs.writeFileSync(original, bytes);
      insertPhotoAsset(db, { id, exhibition_id: exhibitionId, original_name: `${id}.jpg`, storage_path: toRelative(original), thumbnail_path: null, width: 100, height: 80, mime_type: "image/jpeg", file_size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), sort_order: i });
    }
    invalid = null; removeThird = false; emptyMotifs = false;
    transport = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (Array.isArray(body.messages[1].content)) return respond(facts);
      const input = JSON.parse(body.messages[1].content);
      if (input.motif) {
        const chapterIds = invalid === "chapter" ? ["lost", "c2"] : ["c1", "c2"];
        return respond({ selected_motif_id: input.motif.motifId, title: "光的间隔", subtitle: "", curatorial_statement: "沿光线进入墙面的留白。", tone: input.tone,
          chapters: chapterIds.map((id, i) => ({ id, title: i ? "收束" : "进入", description: "侧光延展", photo_ids: i ? [invalid === "narrative" ? "foreign" : "p3"] : ["p1", "p2"], placement_reasons: [{ photo_id: i ? (invalid === "narrative" ? "foreign" : "p3") : "p1", role: i ? "closing" : "opening", reason: "由墙面明暗组织节奏" }] })) });
      }
      if (body.messages[0].content.includes("审美筛选官")) return respond({ decisions: input.photos.map((p: { photoId: string }, i: number) => ({ photo_id: invalid === "curation" && i === 2 ? "foreign" : p.photoId, decision: removeThird && i === 2 ? "remove" : "keep", score: 0.8, confidence: 0.8, reasons: ["墙面侧光形成独特留白"], related_photo_ids: [], user_override_allowed: true })) });
      return respond({ motifs: emptyMotifs ? [] : [{ title: "光的间隔", description: "墙面明暗重复", photo_ids: input.photos.map((p: { photoId: string }) => p.photoId), evidence: ["[p1] 墙面呈蓝色", "[p2] 侧光勾勒墙面"], confidence: 0.8, alternative_readings: ["也可以看作几何练习"] }] });
    });
    vi.stubGlobal("fetch", transport);
  });
  afterEach(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });
  async function run(from: "ingest" | "select" | "motifs" | "narrative", to: "ingest" | "select" | "motifs" | "narrative" | "qa" = from) {
    const started = startPipeline(db, exhibitionId, from, to);
    await vi.waitFor(() => expect(isRunning(db, exhibitionId)).toBe(false));
    return getRun(db, started.run_id)!;
  }
  function confirm() { updateExhibition(db, exhibitionId, { selection_confirmed_revision: getExhibition(db, exhibitionId)!.input_revision, selection_confirmed_photo_ids: JSON.stringify(ids) }); }
  async function seedNarrative() {
    await run("ingest", "select"); confirm(); await run("motifs");
    selectMotif(db, exhibitionId, listMotifs(db, exhibitionId)[0].id);
    await run("narrative");
  }

  it.each(["generic", "deepseek"])("%s：看图→选片→两道门→主题→叙事→规则布局/质检，来源可追溯，原图不变", async (provider) => {
    const deepseek = provider === "deepseek";
    if (deepseek) {
      vi.stubEnv("AI_BASE_URL", "https://api.deepseek.com");
      vi.stubEnv("AI_VISION_MODEL", "deepseek-flash");
      vi.stubEnv("AI_TEXT_MODEL", "");
    }
    const before = ids.map((id) => fs.readFileSync(path.join(uploadsDir(exhibitionId), `${id}.jpg`)));
    expect((await run("ingest", "select")).status).toBe("completed");
    expect(listInspections(db, exhibitionId)).toHaveLength(3);
    expect(getExhibition(db, exhibitionId)!.status).toBe("awaiting_selection_confirm");
    expect(() => startPipeline(db, exhibitionId, "motifs", "motifs")).toThrow("确认选片");
    expect(() => startPipeline(db, exhibitionId, "narrative", "qa")).toThrow("选择一个主题");
    confirm(); const motifRun = await run("motifs");
    expect(motifRun.output_json).toMatchObject({ provenance: { source: "ai", model: deepseek ? "deepseek-flash" : "text-test" }, heuristic_count: 0 });
    selectMotif(db, exhibitionId, listMotifs(db, exhibitionId)[0].id);
    const { run_id } = startPipeline(db, exhibitionId, "narrative", "qa");
    await vi.waitFor(() => expect(isRunning(db, exhibitionId)).toBe(false));
    expect(getRun(db, run_id)!.status).toBe("completed");
    expect(getExhibition(db, exhibitionId)!.status).toBe("awaiting_user_review");
    expect(getNarrative(db, exhibitionId)!.source).toBe("ai");
    expect(getLayout(db, exhibitionId)).not.toBeNull();
    expect(listAiCalls(db)).toHaveLength(6);
    for (const [url, init] of transport.mock.calls) {
      const body = JSON.parse(String(init?.body));
      expect(url).toBe(deepseek ? "https://api.deepseek.com/chat/completions" : "https://api.example.com/v1/chat/completions");
      expect(body.thinking).toEqual(deepseek ? { type: "disabled" } : undefined);
      if (deepseek) expect(body.model).toBe("deepseek-flash");
    }
    expect(getBudgetUsage(db, { scopeType: "job" })).toBe(6);
    ids.forEach((id, i) => expect(fs.readFileSync(path.join(uploadsDir(exhibitionId), `${id}.jpg`)).equals(before[i])).toBe(true));
  });

  it.each([7, 8])("连接探测与三个 workflow 共用每日 %i 次上限，换 workflow 不增额", async (cap) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T03:00:00.000Z"));
    vi.stubEnv("AI_MAX_CALLS_PER_DAY", String(cap));
    vi.stubEnv("AI_DAY_TIMEZONE", "UTC");
    vi.stubEnv("AI_CACHE_ENABLED", "false");
    for (const content of ["AFTERLIGHT_OK", "red"]) {
      transport.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content } }] })));
    }
    const probes = await runAiConnectionTest(db, loadAiConfig());
    expect(probes.text.state).toBe("succeeded");
    expect(probes.vision.state).toBe("succeeded");
    expect((await run("ingest", "select")).status).toBe("completed");
    confirm();
    expect((await run("motifs")).status).toBe("completed");
    selectMotif(db, exhibitionId, listMotifs(db, exhibitionId)[0].id);
    expect((await run("narrative", "qa")).status).toBe(cap === 8 ? "completed" : "failed");
    const oldNarrative = getNarrative(db, exhibitionId);
    expect((await run("narrative", "qa")).status).toBe("failed");
    expect(getNarrative(db, exhibitionId)).toEqual(oldNarrative);
    expect((await runAiConnectionTest(db, loadAiConfig())).errorClass).toBe("budget");
    expect(transport).toHaveBeenCalledTimes(cap);
    expect(listAiCalls(db)).toHaveLength(cap);
    expect(new Set(listAiCalls(db).filter(c => c.scope_type === "workflow").map(c => c.scope_id)).size).toBe(cap === 8 ? 3 : 2);
    expect(getBudgetUsage(db, { scopeType: "global", periodKey: "2026-11-20" })).toBe(cap);
  });

  it("任务总额跨确认门、日期、重新生成及配置调高仍不重置", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T03:00:00Z"));
    vi.stubEnv("AI_MAX_CALLS_PER_JOB", "5");
    vi.stubEnv("AI_MAX_CALLS_PER_DAY", "100");
    vi.stubEnv("AI_CACHE_ENABLED", "false");
    expect((await run("ingest", "select")).status).toBe("completed");
    bumpInputRevision(db, exhibitionId);
    confirm();
    expect((await run("motifs")).status).toBe("completed");
    selectMotif(db, exhibitionId, listMotifs(db, exhibitionId)[0].id);
    vi.setSystemTime(new Date("2026-11-22T03:00:00Z"));
    vi.stubEnv("AI_MAX_CALLS_PER_JOB", "100");
    expect((await run("narrative", "qa")).status).toBe("failed");
    expect((await run("ingest", "select")).status).toBe("failed");
    expect(transport).toHaveBeenCalledTimes(5);
    expect(listAiCalls(db)).toHaveLength(5);
    expect(listInspections(db, exhibitionId)).toHaveLength(3);
    expect(getBudgetUsage(db, { scopeType: "job", periodKey: "total" })).toBe(5);
  });

  it("预留意图失败时 job、workflow、run、幂等键整体回滚，同一请求可重试", async () => {
    expect(() => startPipelineOnce(db, exhibitionId, "ingest", "select", "atomic-job", {
      reserve: () => { throw new Error("mock reservation failure"); },
    })).toThrow("mock reservation failure");
    for (const table of ["curation_jobs", "curation_job_workflows", "agent_runs", "workflow_requests", "ai_budget_counters"]) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect(getExhibition(db, exhibitionId)!.status).toBe("draft");
    expect(isRunning(db, exhibitionId)).toBe(false);
    expect(transport).not.toHaveBeenCalled();
    const first = startPipelineOnce(db, exhibitionId, "ingest", "select", "atomic-job");
    const replay = startPipelineOnce(db, exhibitionId, "ingest", "select", "atomic-job");
    expect(replay).toEqual({ ...first, idempotent: true });
    await vi.waitFor(() => expect(isRunning(db, exhibitionId)).toBe(false));
    expect(transport).toHaveBeenCalledTimes(4);
    expect(db.prepare("SELECT COUNT(*) AS n FROM curation_jobs").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM curation_job_workflows").get()).toEqual({ n: 1 });
  });

  it("must_keep 覆盖 AI remove；选片失败不覆盖旧决定", async () => {
    await run("ingest", "select"); setUserOverride(db, exhibitionId, "p3", "must_keep"); confirm(); removeThird = true;
    await run("select");
    expect(getDecision(db, "p3")).toMatchObject({ ai_decision: "remove", user_override: "must_keep", effective_decision: "must_keep" });
    expect(getExhibition(db, exhibitionId)!.selection_confirmed_revision).not.toBeNull();
    const before = listDecisions(db, exhibitionId); invalid = "curation";
    expect((await run("select")).status).toBe("failed");
    expect(listDecisions(db, exhibitionId)).toEqual(before);
  });

  it("确认集合失配时禁止主题和叙事，不因 revision 非空而外发", async () => {
    await seedNarrative();
    updateExhibition(db, exhibitionId, { selection_confirmed_photo_ids: JSON.stringify(["p1"]) });
    const calls = transport.mock.calls.length;
    expect((await run("motifs")).status).toBe("failed");
    expect((await run("narrative")).status).toBe("failed");
    expect(transport).toHaveBeenCalledTimes(calls);
  });

  it("选片改变有效集合会关门，即使原请求想继续主题也停下", async () => {
    await run("ingest", "select"); confirm(); removeThird = true;
    await run("select", "motifs");
    expect(getExhibition(db, exhibitionId)!.selection_confirmed_revision).toBeNull();
    expect(getExhibition(db, exhibitionId)!.status).toBe("awaiting_selection_confirm");
    expect(listMotifs(db, exhibitionId)).toEqual([]);
  });

  it("重跑保留改名/拒绝；空主题诚实停在主题门", async () => {
    await run("ingest", "select"); confirm(); await run("motifs");
    updateMotif(db, exhibitionId, listMotifs(db, exhibitionId)[0].id, { user_title: "我的光线", state: "rejected" });
    await run("motifs"); expect(listMotifs(db, exhibitionId)[0]).toMatchObject({ user_title: "我的光线", state: "rejected" });
    emptyMotifs = true; expect((await run("motifs")).status).toBe("completed");
    expect(listMotifs(db, exhibitionId)).toEqual([]);
    expect(getExhibition(db, exhibitionId)!.selected_motif_id).toBeNull();
  });

  it("回放跨章移动导致编辑目标消失时拒绝发布，锁定文字与旧作品不丢失", async () => {
    await seedNarrative();
    upsertEdit(db, exhibitionId, "chapter:c1.title", "锁定标题", true);
    upsertEdit(db, exhibitionId, "photo:p1.membership", "c2");
    const before = getNarrative(db, exhibitionId), edits = listEdits(db, exhibitionId), versions = listVersions(db, exhibitionId);
    // Keep the model response valid so this case exercises the later edit-merge conflict.
    transport.mockResolvedValueOnce(respond({ selected_motif_id: getExhibition(db, exhibitionId)!.selected_motif_id,
      title: "重新编排", subtitle: "", curatorial_statement: "沿侧光行进", tone: "restrained", chapters: [
      { id: "c1", title: "进入", description: "墙面开场", photo_ids: ["p1"], placement_reasons: [{ photo_id: "p1", role: "opening", reason: "明暗开场" }] },
      { id: "c2", title: "收束", description: "侧光收束", photo_ids: ["p2", "p3"], placement_reasons: [{ photo_id: "p3", role: "closing", reason: "侧光收束" }] },
    ] }));
    await expect(runNarrative(db, { runId: "merge-conflict", exhibition: getExhibition(db, exhibitionId)! })).rejects.toMatchObject({ code: "narrative_edit_conflict" });
    expect(getNarrative(db, exhibitionId)).toEqual(before);
    expect(listEdits(db, exhibitionId)).toEqual(edits);
    expect(listVersions(db, exhibitionId)).toEqual(versions);
  });

  it.each(["excluded", "stale"])("重新确认后仍拒绝 %s 主题，零外发且不清上游过期标记", async (kind) => {
    await seedNarrative();
    if (kind === "excluded") setUserOverride(db, exhibitionId, "p2", "remove");
    updateExhibition(db, exhibitionId, {
      selection_confirmed_photo_ids: JSON.stringify(kind === "excluded" ? ["p1", "p3"] : ids),
      stale_from: kind === "stale" ? "motifs" : null,
    });
    const before = getNarrative(db, exhibitionId), versions = listVersions(db, exhibitionId), calls = transport.mock.calls.length;
    const stale = getExhibition(db, exhibitionId)!.stale_from;
    await expect(runNarrative(db, { runId: "stale-motif", exhibition: getExhibition(db, exhibitionId)! })).rejects.toMatchObject({ code: "motif_stale" });
    expect(transport).toHaveBeenCalledTimes(calls);
    expect(getNarrative(db, exhibitionId)).toEqual(before);
    expect(listVersions(db, exhibitionId)).toEqual(versions);
    expect(getExhibition(db, exhibitionId)!.stale_from).toBe(stale);
  });

  it("叙事保留文字/章节锁定；缓存复用不冒充新请求，非法重跑不改旧作品/编辑/版本", async () => {
    await seedNarrative();
    upsertEdit(db, exhibitionId, "narrative.title", "我的标题");
    upsertEdit(db, exhibitionId, "chapter:c1.title", "锁定标题", true);
    const ctx = { runId: "rerun", workflowId: "wf_reuse", exhibition: getExhibition(db, exhibitionId)! };
    const first = await runNarrative(db, ctx); const cached = await runNarrative(db, ctx);
    expect(cached.provenance).toMatchObject({ source: "ai_cache", call_id: first.provenance!.call_id });
    expect(getNarrative(db, exhibitionId)).toMatchObject({ title: "我的标题", source: "ai_cache" });
    expect(getNarrative(db, exhibitionId)!.chapters[0].title).toBe("锁定标题");
    const old = getNarrative(db, exhibitionId), edits = listEdits(db, exhibitionId), versions = listVersions(db, exhibitionId);
    for (const failure of ["narrative", "chapter"] as const) {
      invalid = failure; expect((await run("narrative")).status).toBe("failed");
      expect(getNarrative(db, exhibitionId)).toEqual(old); expect(listEdits(db, exhibitionId)).toEqual(edits); expect(listVersions(db, exhibitionId)).toEqual(versions);
    }
  });
});

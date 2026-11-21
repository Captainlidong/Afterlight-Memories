import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createDb } from "@/lib/db/client";
import { createExhibition } from "@/lib/db/repos";
import { AestheticPrefs, CreateExhibitionInput } from "@/lib/agents/schemas";
import { getCurationAdapter, getMotifAdapter, getNarrativeAdapter } from "@/lib/adapters";
import { loadAiConfig } from "@/lib/ai/config";
import type { AiTransport } from "@/lib/ai/client";
import { listAiCalls } from "@/lib/ai/records";
import { AiBusinessValidationError, AiError } from "@/lib/ai/errors";
import type { NarrativeInput } from "@/lib/adapters/types";

const facts = { summary: "蓝色墙面有侧光", subjects: ["墙面"], composition_tags: ["留白"], light_tags: ["侧光"], spatial_relations: [], evidence: [{ kind: "observation" as const, text: "墙面呈蓝色" }], uncertainties: [] };
const photos = ["p1", "p2", "p3"].map((photoId, sort_order) => ({ photoId, sort_order, sha256: photoId, sharpness_score: 0.7, brightness_score: 0.5, highlight_clip_ratio: 0, shadow_clip_ratio: 0, color_temp: 0, saturation: 0.4, subjects: ["墙面"], composition_tags: ["留白"], visual_facts: facts, duplicate_group_id: null }));
const prefs = AestheticPrefs.parse({});
const decisions = () => ({ decisions: photos.map((p) => ({ photo_id: p.photoId, decision: "keep", score: 0.8, confidence: 0.8, reasons: ["蓝色墙面与侧光构成留白"], related_photo_ids: [], user_override_allowed: true })) });
const motifs = () => ({ motifs: [{ title: "蓝色的间隔", description: "墙面与光线的重复", photo_ids: ["p1", "p2"], evidence: ["[p1] 墙面呈蓝色", "[p2] 侧光勾勒墙面"], confidence: 0.8, alternative_readings: ["也可以看作几何练习"] }] });
const plan = () => ({ selected_motif_id: "m1", title: "光的间隔", subtitle: "", curatorial_statement: "从墙面进入，沿侧光收束。", tone: "restrained", chapters: [{ id: "c1", title: "进入", description: "墙面建立方向", photo_ids: ["p1", "p3"], placement_reasons: [{ photo_id: "p1", role: "opening", reason: "留白作为开场" }] }, { id: "c2", title: "留下", description: "侧光收束", photo_ids: ["p2"], placement_reasons: [{ photo_id: "p2", role: "closing", reason: "在侧光处收束" }] }] });
const narrativeInput: NarrativeInput = { photos, mustKeepIds: ["p3"], tone: "restrained", motif: { motifId: "m1", ...motifs().motifs[0] } };
const response = (payload: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 });

describe("真实策展 adapters / Mock（V09–V12/V29）", () => {
  let db: DatabaseSync;
  let exhibitionId: string;
  beforeEach(() => { db = createDb(":memory:"); exhibitionId = createExhibition(db, CreateExhibitionInput.parse({ allow_external_ai: true }), "ai").id; });
  afterEach(() => { db.close(); vi.restoreAllMocks(); });
  function options(payload: unknown, overrides: Partial<NodeJS.ProcessEnv> = {}) {
    const transport = vi.fn<AiTransport>(async () => response(payload));
    return { db, exhibitionId, workflowId: "wf_text", transport, config: loadAiConfig({ NODE_ENV: "test", AI_API_KEY: "mock-only", AI_BASE_URL: "https://api.example.com/v1", AI_VISION_MODEL: "vision", AI_TEXT_MODEL: "text", AI_MAX_RETRIES: "0", ...overrides }) };
  }
  const cacheCount = () => (db.prepare("SELECT COUNT(*) AS n FROM ai_cache").get() as { n: number }).n;

  it("真实文本模型/事实输入，fresh 与 cache 关联原调用且不重新请求", async () => {
    const opts = options(decisions());
    const adapter = getCurationAdapter("ai", opts);
    const fresh = await adapter.curate({ photos, prefs });
    const cached = await adapter.curate({ photos, prefs });
    expect(fresh.provenance).toMatchObject({ source: "ai", model: "text", cache_hit: false });
    expect(cached.provenance).toMatchObject({ source: "ai_cache", call_id: fresh.provenance!.call_id, cache_hit: true });
    expect(fresh.provenance!.call_id).toBe(listAiCalls(db)[0].id);
    expect(opts.transport).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(opts.transport.mock.calls[0]?.[1]?.body));
    expect(body.model).toBe("text");
    expect(JSON.parse(body.messages[1].content).photos[0].visual_facts).toEqual(facts);
    await adapter.curate({ photos, prefs: { ...prefs, repetition: "more" } });
    await adapter.curate({ photos: [...photos].reverse(), prefs });
    await adapter.curate({ photos: photos.map((p) => ({ ...p, visual_facts: { ...facts, summary: "白色墙面" } })), prefs });
    expect(opts.transport).toHaveBeenCalledTimes(4);
  });

  it.each(["missing", "duplicate", "foreign", "related", "related_duplicate", "permission", "html", "fiction"])("拒绝非法选片 %s，不缓存", async (kind) => {
    const payload = decisions();
    if (kind === "missing") payload.decisions.pop();
    if (kind === "duplicate") payload.decisions[1].photo_id = "p1";
    if (kind === "foreign") payload.decisions[1].photo_id = "stranger";
    if (kind === "related") (payload.decisions[1].related_photo_ids as string[]).push("stranger");
    if (kind === "related_duplicate") (payload.decisions[1].related_photo_ids as string[]).push("p1", "p1");
    if (kind === "permission") payload.decisions[1].user_override_allowed = false;
    if (kind === "html") payload.decisions[1].reasons = ["<img src=x onerror=alert(1)>"];
    if (kind === "fiction") payload.decisions[1].reasons = ["情侣在毕业典礼相遇"];
    await expect(getCurationAdapter("ai", options(payload)).curate({ photos, prefs })).rejects.toThrow(AiError);
    expect(cacheCount()).toBe(0);
    expect(listAiCalls(db)[0].error_class).toBe(["permission", "html"].includes(kind) ? "invalid_response" : "invalid_reference");
  });

  it("切换模型或输出上限各自缓存，切回旧配置仍复用原调用", async () => {
    const first = options(decisions());
    const otherModel = options(decisions(), { AI_TEXT_MODEL: "other-text" });
    const otherLimit = options(decisions(), { AI_MAX_OUTPUT_TOKENS: "1024" });
    const a = await getCurationAdapter("ai", first).curate({ photos, prefs });
    const b = await getCurationAdapter("ai", otherModel).curate({ photos, prefs });
    const c = await getCurationAdapter("ai", otherLimit).curate({ photos, prefs });
    expect(new Set([a.provenance!.call_id, b.provenance!.call_id, c.provenance!.call_id]).size).toBe(3);
    for (const opts of [first, otherModel, otherLimit]) {
      expect((await getCurationAdapter("ai", opts).curate({ photos, prefs })).provenance?.source).toBe("ai_cache");
      expect(opts.transport).toHaveBeenCalledTimes(1);
    }
    expect(cacheCount()).toBe(3);
  });

  it.each([0, 1])("允许 %i 个有效主题，不凑数", async (count) => {
    const payload = motifs(); payload.motifs.length = count;
    expect((await getMotifAdapter("ai", options(payload)).discover({ photos, prefs })).motifs).toHaveLength(count);
  });

  it.each(["foreign", "one_evidence", "unlocated", "empty_observation", "duplicate_observation", "duplicate_title", "supplied_id", "fiction", "blank_reading"])("拒绝主题 %s", async (kind) => {
    const payload = motifs();
    if (kind === "foreign") payload.motifs[0].photo_ids.push("stranger");
    if (kind === "one_evidence") payload.motifs[0].evidence.pop();
    if (kind === "unlocated") payload.motifs[0].evidence[0] = "整体很优美";
    if (kind === "empty_observation") payload.motifs[0].evidence[0] = "[p1]   ";
    if (kind === "duplicate_observation") payload.motifs[0].evidence[1] = "[p1] 墙面 呈蓝色";
    if (kind === "blank_reading") payload.motifs[0].alternative_readings = ["  " ];
    if (kind === "fiction") payload.motifs[0].description = "家人之间隐藏着思念";
    if (kind === "duplicate_title") payload.motifs.push({ ...payload.motifs[0] });
    if (kind === "supplied_id") Object.assign(payload.motifs[0], { id: "other-exhibition-motif" });
    await expect(getMotifAdapter("ai", options(payload)).discover({ photos, prefs })).rejects.toThrow(AiError);
    expect(cacheCount()).toBe(0);
  });

  it("叙事合法且语气/主题变化失效缓存", async () => {
    const opts = options(plan());
    const adapter = getNarrativeAdapter("ai", opts);
    expect((await adapter.compose(narrativeInput)).provenance?.source).toBe("ai");
    expect((await adapter.compose(narrativeInput)).provenance?.source).toBe("ai_cache");
    opts.transport.mockImplementation(async () => response({ ...plan(), tone: "direct" }));
    await adapter.compose({ ...narrativeInput, tone: "direct" });
    opts.transport.mockImplementation(async () => response({ ...plan(), selected_motif_id: "m2" }));
    await adapter.compose({ ...narrativeInput, motif: { ...narrativeInput.motif, motifId: "m2" } });
    expect(opts.transport).toHaveBeenCalledTimes(3);
  });

  it.each(["empty", "foreign", "duplicate", "must_keep", "chapter_id", "anchor", "motif", "missing_motif", "tone", "fiction", "script", "tool", "blank_statement", "blank_description", "blank_reason"])("拒绝叙事 %s 且不缓存", async (kind) => {
    const payload = plan();
    if (kind === "empty") payload.chapters[0].photo_ids = [];
    if (kind === "foreign") payload.chapters[0].photo_ids.push("stranger");
    if (kind === "duplicate") payload.chapters[1].photo_ids.push("p1");
    if (kind === "must_keep") payload.chapters[0].photo_ids = ["p1"];
    if (kind === "chapter_id") payload.chapters[1].id = "c1";
    if (kind === "anchor") payload.chapters[0].placement_reasons[0].photo_id = "p2";
    if (kind === "motif") payload.selected_motif_id = "stranger";
    if (kind === "missing_motif") Reflect.deleteProperty(payload, "selected_motif_id");
    if (kind === "tone") payload.tone = "direct";
    if (kind === "fiction") payload.curatorial_statement = "这是他们分手之后的回忆";
    if (kind === "script") payload.curatorial_statement = "<script>alert(1)</script>";
    if (kind === "tool") Object.assign(payload, { tool_calls: [{ name: "send_all_photos" }] });
    if (kind === "blank_statement") payload.curatorial_statement = " \t \n";
    if (kind === "blank_description") payload.chapters[0].description = "   ";
    if (kind === "blank_reason") payload.chapters[0].placement_reasons[0].reason = "  ";
    await expect(getNarrativeAdapter("ai", options(payload)).compose(narrativeInput)).rejects.toThrow(AiError);
    expect(cacheCount()).toBe(0);
  });

  it("叙事业务校验失败时在服务端日志留下原始输出样本（真实联调诊断），错误分类与缓存行为不变", async () => {
    const payload = plan();
    payload.tone = "direct"; // 与输入语气不符，触发 adapter 业务校验失败
    let logged = "";
    const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      logged += args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
    });
    try {
      await expect(getNarrativeAdapter("ai", options(payload)).compose(narrativeInput)).rejects.toThrow(AiError);
    } finally {
      warn.mockRestore();
    }
    expect(logged).toContain("[afterlight][ai-diagnostics]");
    expect(logged).toContain("narrative");
    expect(logged).toContain('"tone":"direct"');
    expect(cacheCount()).toBe(0);
  });

  it("缺视觉事实/未配置/撤销授权均零请求，不回退 Demo", async () => {
    const opts = options(decisions());
    await expect(getCurationAdapter("ai", opts).curate({ photos: photos.map((p) => ({ ...p, visual_facts: null })), prefs })).rejects.toMatchObject({ code: "visual_facts_required" });
    expect(opts.transport).not.toHaveBeenCalled();
    const missing = options(decisions(), { NODE_ENV: "test", AI_API_KEY: "" });
    await expect(getCurationAdapter("ai", missing).curate({ photos, prefs })).rejects.toMatchObject({ cls: "config" });
    expect(missing.transport).not.toHaveBeenCalled();
    db.prepare("UPDATE exhibitions SET allow_external_ai=0 WHERE id=?").run(exhibitionId);
    await expect(getCurationAdapter("ai", opts).curate({ photos, prefs })).rejects.toMatchObject({ cls: "unauthorized" });
    expect(opts.transport).not.toHaveBeenCalled();
  });

  it("业务校验触发一次有界修复，只有合法结果入缓存", async () => {
    const opts = options({}, { NODE_ENV: "test", AI_MAX_RETRIES: "1" });
    const malformed = decisions(); malformed.decisions[0].reasons = [];
    opts.transport.mockResolvedValueOnce(response(malformed)).mockResolvedValueOnce(response(decisions()));
    await getCurationAdapter("ai", opts).curate({ photos, prefs });
    expect(opts.transport).toHaveBeenCalledTimes(2);
    expect(cacheCount()).toBe(1);
    expect(listAiCalls(db).map((r) => r.status).sort()).toEqual(["failed", "succeeded"]);
  });

  it("业务引用错误不伪装为格式修复，开启重试也只外发一次", async () => {
    const invalid = decisions(); invalid.decisions[0].photo_id = "foreign";
    const opts = options(invalid, { AI_MAX_RETRIES: "3" });
    await expect(getCurationAdapter("ai", opts).curate({ photos, prefs })).rejects.toThrow(AiBusinessValidationError);
    expect(opts.transport).toHaveBeenCalledTimes(1);
    expect(listAiCalls(db)).toHaveLength(1);
    expect(listAiCalls(db)[0].error_class).toBe("invalid_reference");
    expect(cacheCount()).toBe(0);
  });

  it("文本请求接入任务所有权，等待期间失效不缓存不返回成功", async () => {
    let active = true;
    const opts = options(decisions());
    opts.transport.mockImplementation(async () => { active = false; return response(decisions()); });
    const adapter = getCurationAdapter("ai", { ...opts, assertActive() { if (!active) throw new Error("expired lease"); } });
    await expect(adapter.curate({ photos, prefs })).rejects.toMatchObject({ cls: "stale_context" });
    expect(opts.transport).toHaveBeenCalledTimes(1);
    expect(cacheCount()).toBe(0);
    expect(listAiCalls(db)[0].status).toBe("failed");
  });

  it("文本调用传递取消信号，已取消请求零外发", async () => {
    const opts = options(decisions());
    const controller = new AbortController(); controller.abort();
    await expect(getCurationAdapter("ai", { ...opts, signal: controller.signal }).curate({ photos, prefs })).rejects.toMatchObject({ cls: "cancelled" });
    expect(opts.transport).not.toHaveBeenCalled();
    expect(listAiCalls(db)).toHaveLength(0);
  });

  it("文本发送前重核当前配置，旧配置请求不会发出", async () => {
    const opts = options(decisions());
    const otherConfig = { ...opts.config, textModel: "changed-text" };
    const getCurrentConfig = vi.fn().mockReturnValueOnce(opts.config).mockReturnValue(otherConfig);
    await expect(getCurationAdapter("ai", { ...opts, getCurrentConfig }).curate({ photos, prefs })).rejects.toMatchObject({ cls: "config" });
    expect(opts.transport).not.toHaveBeenCalled();
    expect(listAiCalls(db)).toHaveLength(0);
  });
});

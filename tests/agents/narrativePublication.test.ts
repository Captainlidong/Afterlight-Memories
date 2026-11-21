import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "@/lib/db/migrations";
import { createExhibition, getExhibition, updateExhibition, bumpInputRevision } from "@/lib/db/repos";
import { insertPhotoAsset, upsertInspection } from "@/lib/db/photos";
import { upsertAiDecision } from "@/lib/db/curation";
import { replaceMotifs, listMotifs, selectMotif } from "@/lib/db/motifs";
import { getNarrative, replaceNarrative } from "@/lib/db/narrative";
import { listEdits, upsertEdit } from "@/lib/db/edits";
import { getRegenerationIntent, insertRegenerationIntent } from "@/lib/db/regenerations";
import { runNarrative } from "@/lib/agents/narrativeEditor";
import { CreateExhibitionInput, PhotoInspection, NarrativePlan, Motif } from "@/lib/agents/schemas";

const mock = vi.hoisted(() => ({ compose: vi.fn() }));
vi.mock("@/lib/adapters", () => ({ getNarrativeAdapter: () => ({ compose: mock.compose }) }));
let db: DatabaseSync;
let id: string;
const plan = () => NarrativePlan.parse({ title: "生成结果", curatorial_statement: "光线穿过窗。", tone: "poetic", chapters: [
  { id: "c1", title: "进入", description: "窗", photo_ids: ["p1", "p2"] },
  { id: "c2", title: "留下", description: "光", photo_ids: ["p3"] },
] });
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  migrate(db);
  id = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
  for (const pid of ["p1", "p2", "p3"]) {
    insertPhotoAsset(db, { id: pid, exhibition_id: id, original_name: "unused.jpg", storage_path: "unused", thumbnail_path: null, width: 10, height: 10, mime_type: "image/jpeg", file_size: 10, sha256: pid, sort_order: 0 });
    upsertInspection(db, PhotoInspection.parse({ photo_id: pid, sharpness_score: 0.7, laplacian_var: 100, brightness_score: 0.5, highlight_clip_ratio: 0, shadow_clip_ratio: 0, dominant_colors: [], processing_mode: "heuristic" }));
    upsertAiDecision(db, id, { photo_id: pid, decision: "keep", score: 0.7, confidence: 0.7, reasons: [], related_photo_ids: [], user_override_allowed: true });
  }
  replaceMotifs(db, id, [Motif.parse({ title: "窗", description: "光线", photo_ids: ["p1"], evidence: ["窗"], confidence: 0.7 })]);
  selectMotif(db, id, listMotifs(db, id)[0].id);
  replaceNarrative(db, id, { ...plan(), title: "旧作品", tone: "restrained" }, { source: "heuristic", inputVersion: 0 });
  updateExhibition(db, id, { status: "awaiting_user_review", stale_from: "narrative" });
  upsertEdit(db, id, "narrative.title", "作者的婚礼", true);
  mock.compose.mockReset().mockResolvedValue(plan());
});
afterEach(() => { db.close(); });
function intent(scope: "all" | "unlocked" | "preserve" = "all") {
  insertRegenerationIntent(db, { runId: "run", workflowId: "wf", exhibitionId: id, scope, tone: "poetic", expectedInputRevision: getExhibition(db, id)!.input_revision });
}
function run(assertOwner?: () => void) { return runNarrative(db, { runId: "run", workflowId: "wf", exhibition: getExhibition(db, id)!, assertOwner }); }
function saved() { return { narrative: getNarrative(db, id), edits: listEdits(db, id), tone: getExhibition(db, id)!.tone, version: getExhibition(db, id)!.current_version }; }

describe("叙事发布原子守卫", () => {
  it("章节数按保留照片数钳制：3 张保留传 3，2 张保留传 2（真实联调修复：小集不再要求不可能的跨章结构）", async () => {
    await run();
    expect(mock.compose.mock.calls[0][0].chapterCount).toBe(3);
    upsertAiDecision(db, id, { photo_id: "p3", decision: "hold", score: 0.5, confidence: 0.7, reasons: [], related_photo_ids: [], user_override_allowed: true });
    mock.compose.mockResolvedValue(NarrativePlan.parse({ title: "两张", curatorial_statement: "光线穿过窗。", tone: "poetic", chapters: [
      { id: "c1", title: "进入", description: "窗", photo_ids: ["p1"] },
      { id: "c2", title: "留下", description: "光", photo_ids: ["p2"] },
    ] }));
    await run();
    expect(mock.compose.mock.calls[1][0].chapterCount).toBe(2);
  });

  it("await 期间 intent 输入过期拒绝整次发布，不只是 superseded 后继续", async () => {
    intent();
    const before = saved();
    mock.compose.mockImplementation(async () => { bumpInputRevision(db, id); return plan(); });
    await expect(run()).rejects.toMatchObject({ code: "version_conflict" });
    expect(saved()).toEqual(before);
    expect(getRegenerationIntent(db, "run")!.state).toBe("pending");
  });

  it("assertOwner 必须在发布事务内再次校验，拒绝后不写任何产物", async () => {
    intent();
    const before = saved();
    const assertOwner = vi.fn(() => { if (db.isTransaction) throw new Error("fenced"); });
    await expect(run(assertOwner)).rejects.toThrow("fenced");
    expect(saved()).toEqual(before);
    expect(getRegenerationIntent(db, "run")!.state).toBe("pending");
    expect(assertOwner).toHaveBeenCalledTimes(2);
  });

  it("preserve 保留全部作者文字，成功发布才应用 tone", async () => {
    intent("preserve");
    upsertEdit(db, id, "narrative.subtitle", "作者的家人", false);
    const result = await run();
    expect(result.tone).toBe("poetic");
    expect(getNarrative(db, id)).toMatchObject({ title: "作者的婚礼", subtitle: "作者的家人" });
    expect(listEdits(db, id)).toHaveLength(2);
    expect(getRegenerationIntent(db, "run")!.state).toBe("applied");
  });

  it.each([
    ["photo:missing.placement", "opening"],
    ["chapter:missing.locked", true],
    ["chapter:c1.photo_order", ["p3"]],
  ])("无效锁定目标拒绝发布且保留旧作品：%s", async (target, value) => {
    upsertEdit(db, id, target, value, true);
    intent("unlocked");
    const before = saved();
    await expect(run()).rejects.toMatchObject({ code: "narrative_edit_conflict" });
    expect(saved()).toEqual(before);
    expect(getRegenerationIntent(db, "run")!.state).toBe("pending");
  });

  it("重复章节 id 不能被 merge 当成合法结果发布", async () => {
    const bad = plan();
    bad.chapters[1].id = "c1";
    mock.compose.mockResolvedValue(bad);
    intent();
    const before = saved();
    await expect(run()).rejects.toMatchObject({ code: "narrative_structure" });
    expect(saved()).toEqual(before);
  });
});

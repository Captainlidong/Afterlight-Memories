import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createDb } from "@/lib/db/client";
import { createExhibition, getExhibition, updateExhibition, bumpInputRevision } from "@/lib/db/repos";
import * as adapters from "@/lib/adapters";
import { startPipeline, isRunning } from "@/lib/orchestrator/orchestrator";
import { getRun } from "@/lib/db/runs";
import { insertPhotoAsset, upsertInspection } from "@/lib/db/photos";
import { upsertAiDecision } from "@/lib/db/curation";
import { replaceMotifs, selectMotif } from "@/lib/db/motifs";
import { replaceNarrative } from "@/lib/db/narrative";
import { replaceLayout } from "@/lib/db/layout";
import { replaceQa } from "@/lib/db/qa";
import { CreateExhibitionInput, PhotoInspection } from "@/lib/agents/schemas";
import { runSelect } from "@/lib/agents/aestheticSelector";
import { runMotifs } from "@/lib/agents/motifFinder";
import { runExhibition } from "@/lib/agents/exhibitionDesigner";
import { runQa, fixIssue } from "@/lib/agents/curatorialQa";
import { ApiError } from "@/lib/api/errors";

vi.mock("@/lib/adapters", () => ({
  getCurationAdapter: () => ({ curate: async () => ({ decisions: [{
    photo_id: "p1", decision: "remove", score: 0.1, confidence: 0.8,
    reasons: ["mock changed decision"], related_photo_ids: [], user_override_allowed: true,
  }] }) }),
  getMotifAdapter: () => ({ discover: async () => ({ motifs: [{
    id: "new-motif", title: "光", description: "新的描述", photo_ids: ["p1", "p2"],
    evidence: ["光线"], confidence: 0.8, alternative_readings: [],
  }] }) }),
}));

let db: DatabaseSync;
let id: string;

beforeEach(() => {
  db = createDb(":memory:");
  id = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
  for (const pid of ["p1", "p2"]) {
    insertPhotoAsset(db, { id: pid, exhibition_id: id, original_name: "synthetic.jpg",
      storage_path: "unused.jpg", thumbnail_path: "unused-thumb.jpg", width: 200, height: 200,
      mime_type: "image/jpeg", file_size: 1, sha256: "synthetic", sort_order: 0 });
    upsertInspection(db, PhotoInspection.parse({ photo_id: pid, sharpness_score: 0.7,
      laplacian_var: 100, brightness_score: 0.5, highlight_clip_ratio: 0, shadow_clip_ratio: 0,
      dominant_colors: ["#123456"], subjects: ["窗"], processing_mode: "heuristic" }));
    upsertAiDecision(db, id, { photo_id: pid, decision: "keep", score: 0.7, confidence: 0.8,
      reasons: ["existing"], related_photo_ids: [], user_override_allowed: true });
  }
  replaceMotifs(db, id, [{ id: "old-motif", title: "光", description: "旧描述", photo_ids: ["p1", "p2"],
    evidence: ["光线"], confidence: 0.7, alternative_readings: [] }]);
  selectMotif(db, id, "old-motif", "用户改名");
  updateExhibition(db, id, { selection_confirmed_revision: 0, status: "awaiting_user_review" });
  replaceNarrative(db, id, { title: "旧叙事", subtitle: "", curatorial_statement: "光线与空间。", tone: "restrained",
    chapters: ["p1", "p2"].map((pid, n) => ({ id: `ch${n}`, title: `章节${n}`, description: "窗与光。",
      photo_ids: [pid], placement_reasons: [], locked: false })) }, { source: "mock", inputVersion: 0 });
  replaceLayout(db, id, { template: "cinema_scroll", background: "#000", text_color: "#fff",
    sections: [{ id: "old-hero", type: "hero", photo_id: "p1", height: "92vh", caption_position: "bottom-left" },
      { id: "old-ending", type: "ending", photo_ids: ["p1", "p2"] }] }, { inputVersion: 0 });
  replaceQa(db, id, { status: "needs_review", passed_checks: [], issues: [{ id: "dup", type: "repetition",
    severity: "high", message: "duplicate", photo_ids: ["p1"], auto_fix_available: true }] }, {});
});
afterEach(() => { db.close(); vi.restoreAllMocks(); });

function snapshot() {
  return ["exhibitions", "curation_decisions", "motifs", "narrative_plans", "exhibition_layouts", "qa_reports", "exhibition_versions"]
    .map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

const agents = [
  ["select", runSelect], ["motifs", runMotifs], ["layout", runExhibition], ["qa", runQa],
] as const;

describe("S09 agent publication transactions", () => {
  it.each(agents)("%s guard 与写入在同一短事务", async (_name, run) => {
    const guard = vi.fn(() => expect(db.isTransaction).toBe(true));
    await run(db, { runId: "test-run", exhibition: getExhibition(db, id)!, assertOwner: guard });
    expect(guard).toHaveBeenCalled();
    expect(db.isTransaction).toBe(false);
  });

  it.each(agents)("%s guard 拒绝时旧作品逐表不变", async (_name, run) => {
    const before = snapshot();
    await expect(run(db, { runId: "test-run", exhibition: getExhibition(db, id)!, assertOwner: () => {
      expect(db.isTransaction).toBe(true);
      throw new ApiError(409, "run_fenced", "stale_input");
    } })).rejects.toMatchObject({ code: "run_fenced" });
    expect(snapshot()).toEqual(before);
    expect(db.isTransaction).toBe(false);
  });

  it.each(agents)("%s stale 写入失败：产物/选择/确认/快照一起回滚", async (_name, run) => {
    const before = snapshot();
    db.exec(`CREATE TRIGGER reject_stale BEFORE UPDATE OF stale_from ON exhibitions
      BEGIN SELECT RAISE(ABORT, 'stale write failed'); END`);
    await expect(run(db, { runId: "test-run", exhibition: getExhibition(db, id)! })).rejects.toThrow("stale write failed");
    expect(snapshot()).toEqual(before);
    expect(db.isTransaction).toBe(false);
  });

  it.each(["select", "motifs"] as const)("真实 %s agent 等待 adapter 期间修订变化：所有旧产物不变", async (stage) => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const pause = async () => { entered.resolve(); await resume.promise; };
    if (stage === "select") {
      const adapter = adapters.getCurationAdapter("demo");
      vi.spyOn(adapters, "getCurationAdapter").mockReturnValueOnce({ curate: async (input) => {
        await pause(); return adapter.curate(input);
      } });
    } else {
      const adapter = adapters.getMotifAdapter("demo");
      vi.spyOn(adapters, "getMotifAdapter").mockReturnValueOnce({ discover: async (input) => {
        await pause(); return adapter.discover(input);
      } });
    }
    const before = snapshot().slice(1);
    const { run_id } = startPipeline(db, id, stage, stage);
    await entered.promise;
    bumpInputRevision(db, id);
    updateExhibition(db, id, { status: "awaiting_user_review", title: "new input" });
    resume.resolve();
    await vi.waitFor(() => expect(isRunning(db, id)).toBe(false));
    expect(snapshot().slice(1)).toEqual(before);
    expect(getExhibition(db, id)).toMatchObject({ title: "new input", status: "awaiting_user_review" });
    expect(getRun(db, run_id)!.error_message).toContain("stale_input");
    expect(getRun(db, run_id)!.status).toBe("failed");
  });

  it("replaceMotifs 可复用外层事务，选择延续随外层回滚", () => {
    const before = snapshot();
    db.exec("BEGIN IMMEDIATE");
    try {
      replaceMotifs(db, id, [{ id: "replacement", title: "光", description: "new", photo_ids: ["p1"],
        evidence: ["光"], confidence: 0.8, alternative_readings: [] }]);
      expect(getExhibition(db, id)!.selected_motif_id).toBe("replacement");
      expect(db.isTransaction).toBe(true);
    } finally { if (db.isTransaction) db.exec("ROLLBACK"); }
    expect(snapshot()).toEqual(before);
  });

  it("QA 自动修复的报告失败不能留下半份新布局", () => {
    const before = snapshot();
    db.exec(`CREATE TRIGGER reject_qa BEFORE UPDATE ON qa_reports
      BEGIN SELECT RAISE(ABORT, 'qa write failed'); END`);
    expect(() => fixIssue(db, id, "dup")).toThrow("qa write failed");
    expect(snapshot()).toEqual(before);
  });
});

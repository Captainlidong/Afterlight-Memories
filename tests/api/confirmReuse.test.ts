import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createDb, getDb } from "@/lib/db/client";
import { createExhibition, getExhibition } from "@/lib/db/repos";
import { insertPhotoAsset } from "@/lib/db/photos";
import { upsertAiDecision, setUserOverride } from "@/lib/db/curation";
import { listMotifs } from "@/lib/db/motifs";
import { listRuns } from "@/lib/db/runs";
import { isRunning } from "@/lib/orchestrator/orchestrator";
import { markStale } from "@/lib/orchestrator/rerunMatrix";
import { CreateExhibitionInput, type CurationDecisionT } from "@/lib/agents/schemas";
import { prepareUpload } from "@/lib/image/pipeline";
import { uploadsDir, toRelative } from "@/lib/files";
import { newId } from "@/lib/id";
import { POST as postConfirm } from "@/app/api/exhibitions/[id]/curation/confirm/route";
import { POST as postIngest } from "@/app/api/exhibitions/[id]/runs/ingest/route";
import type { DatabaseSync } from "node:sqlite";

let tmp: string;
let db: DatabaseSync;
let exhId: string;
const photoIds: string[] = [];

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function post(body: unknown) {
  const req = new Request(`http://localhost/api/exhibitions/${exhId}/curation/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await postConfirm(req, ctx(exhId) as never);
  return { status: res.status, body: await res.json() };
}

async function waitDone(timeout = 10000): Promise<void> {
  const start = Date.now();
  while (isRunning(db, exhId)) {
    if (Date.now() - start > timeout) throw new Error("pipeline 超时");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function decide(pid: string, decision: "keep" | "hold" | "remove") {
  const d: CurationDecisionT = {
    photo_id: pid, decision, score: 0.7, confidence: 0.8,
    reasons: ["测试决定"], related_photo_ids: [], user_override_allowed: true,
  };
  upsertAiDecision(db, exhId, d);
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-reuse-"));
  process.env.AFTERLIGHT_DATA_DIR = tmp;
  (globalThis as unknown as { __afterlightDb?: unknown }).__afterlightDb = createDb(":memory:");
  db = getDb();
  exhId = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;

  const colors = [
    { r: 60, g: 80, b: 120 },
    { r: 180, g: 140, b: 90 },
    { r: 90, g: 150, b: 100 },
  ];
  for (const [i, c] of colors.entries()) {
    const buf = await sharp({ create: { width: 120, height: 90, channels: 3, background: c } }).jpeg().toBuffer();
    const pid = newId("photo");
    const prepared = await prepareUpload(buf);
    const dir = uploadsDir(exhId);
    fs.mkdirSync(dir, { recursive: true });
    const origAbs = path.join(dir, `${pid}.jpg`);
    fs.writeFileSync(origAbs, buf);
    fs.writeFileSync(path.join(dir, `thumb_${pid}.jpg`), prepared.thumbnail);
    insertPhotoAsset(db, {
      id: pid, exhibition_id: exhId, original_name: `p${i}.jpg`,
      storage_path: toRelative(origAbs), thumbnail_path: toRelative(path.join(dir, `thumb_${pid}.jpg`)),
      width: prepared.width, height: prepared.height, mime_type: "image/jpeg",
      file_size: buf.length, sha256: prepared.sha256, sort_order: i,
    });
    photoIds.push(pid);
  }
});

afterAll(() => {
  delete (globalThis as unknown as { __afterlightDb?: unknown }).__afterlightDb;
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.AFTERLIGHT_DATA_DIR;
});

describe("UX-1 补丁：确认选片复用有效主题（§19.3 同输入不重复发现）", () => {
  it("首次确认（discover_motifs=false）：还没有主题 → reused_motifs=false", async () => {
    const req = new Request(`http://localhost/api/exhibitions/${exhId}/runs/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: "req_reuse_ingest" }),
    });
    const res = await postIngest(req, ctx(exhId) as never);
    expect(res.status).toBe(202);
    await waitDone();
    decide(photoIds[0], "keep");
    decide(photoIds[1], "hold");
    decide(photoIds[2], "remove");
    setUserOverride(db, exhId, photoIds[2], "must_keep");

    const rev = getExhibition(db, exhId)!.input_revision;
    const { status, body } = await post({
      expected_revision: rev, hold_policy: "exclude", discover_motifs: false, request_id: "req_reuse_1",
    });
    expect(status).toBe(200);
    expect(body.reused_motifs).toBe(false);
    expect(body.workflow_id).toBeNull();
    expect(listMotifs(db, exhId).length).toBe(0);
  });

  it("同选择再次确认但主题不存在 → 正常跑 motifs（不复用）", async () => {
    const rev = getExhibition(db, exhId)!.input_revision;
    const { status, body } = await post({ expected_revision: rev, request_id: "req_reuse_2" });
    expect(status).toBe(200);
    expect(body.reused_motifs).toBe(false);
    expect(body.workflow_id).toMatch(/^wf_/);
    await waitDone();
    expect(getExhibition(db, exhId)!.status).toBe("awaiting_theme_choice");
    expect(listMotifs(db, exhId).length).toBeGreaterThan(0);
  });

  it("同选择、主题有效 → 复用：不新建运行、不重跑模型，仍 bump revision 并写操作历史", async () => {
    const before = getExhibition(db, exhId)!.input_revision;
    const runsBefore = listRuns(db, exhId).length;
    const motifsBefore = listMotifs(db, exhId).map((m) => m.id);
    const { status, body } = await post({ expected_revision: before, request_id: "req_reuse_3" });
    expect(status).toBe(200);
    expect(body.reused_motifs).toBe(true);
    expect(body.workflow_id).toBeNull();
    expect(body.run_id).toBeNull();
    expect(body.revision).toBe(before + 1);
    expect(getExhibition(db, exhId)!.input_revision).toBe(before + 1);
    expect(getExhibition(db, exhId)!.selection_confirmed_revision).toBe(before + 1);
    expect(listRuns(db, exhId).length).toBe(runsBefore);
    expect(listMotifs(db, exhId).map((m) => m.id)).toEqual(motifsBefore);
    expect(getExhibition(db, exhId)!.status).toBe("awaiting_theme_choice");
    const op = db.prepare("SELECT action FROM curation_operations WHERE id=?").get(body.operation_id) as { action: string };
    expect(op.action).toBe("confirm_selection");
  });

  it("主题已过期（stale_from=motifs）→ 即使同选择也重新发现", async () => {
    markStale(db, exhId, "motifs");
    const rev = getExhibition(db, exhId)!.input_revision;
    const runsBefore = listRuns(db, exhId).length;
    const { status, body } = await post({ expected_revision: rev, request_id: "req_reuse_4" });
    expect(status).toBe(200);
    expect(body.reused_motifs).toBe(false);
    expect(body.workflow_id).toMatch(/^wf_/);
    await waitDone();
    expect(listRuns(db, exhId).length).toBeGreaterThan(runsBefore);
  });

  it("保留集变化（hold 纳入）→ 不复用，重新发现", async () => {
    setUserOverride(db, exhId, photoIds[1], "keep");
    const rev = getExhibition(db, exhId)!.input_revision;
    const { status, body } = await post({ expected_revision: rev, request_id: "req_reuse_5" });
    expect(status).toBe(200);
    expect(body.reused_motifs).toBe(false);
    expect(body.workflow_id).toMatch(/^wf_/);
    expect(body.confirmed_photo_ids.sort()).toEqual([...photoIds].sort());
    await waitDone();
  });
});
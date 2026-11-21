import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createDb, getDb } from "@/lib/db/client";
import { createExhibition, getExhibition } from "@/lib/db/repos";
import { insertPhotoAsset } from "@/lib/db/photos";
import { upsertAiDecision, setUserOverride, listDecisions } from "@/lib/db/curation";
import { listRuns } from "@/lib/db/runs";
import { isRunning } from "@/lib/orchestrator/orchestrator";
import { CreateExhibitionInput, type CurationDecisionT } from "@/lib/agents/schemas";
import { prepareUpload } from "@/lib/image/pipeline";
import { uploadsDir, toRelative } from "@/lib/files";
import { newId } from "@/lib/id";
import { POST as postIngest } from "@/app/api/exhibitions/[id]/runs/ingest/route";
import { POST as postMotifs } from "@/app/api/exhibitions/[id]/runs/motifs/route";
import { POST as postConfirm } from "@/app/api/exhibitions/[id]/curation/confirm/route";
import { GET as getStatus } from "@/app/api/exhibitions/[id]/status/route";
import { PATCH as patchDecision } from "@/app/api/exhibitions/[id]/photos/[photoId]/decision/route";
import type { DatabaseSync } from "node:sqlite";

let tmp: string;
let db: DatabaseSync;
let exhId: string;
const photoIds: string[] = [];

function ctx(id: string, pid?: string) {
  return { params: Promise.resolve(pid ? { id, photoId: pid } : { id }) };
}

async function post(route: (req: Request, c: never) => Promise<Response>, body?: unknown) {
  const req = new Request(`http://localhost/api/exhibitions/${exhId}/x`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const res = await route(req, ctx(exhId) as never);
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-confirm-"));
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

describe("UX-1 默认流程：ingest→select 停在确认选片门", () => {
  it("runs/ingest 只跑 ingest→select，停在 awaiting_selection_confirm，返回 workflow_id", async () => {
    const { status, body } = await post(postIngest);
    expect(status).toBe(202);
    expect(body.workflow_id).toMatch(/^wf_/);
    await waitDone();

    const exh = getExhibition(db, exhId)!;
    expect(exh.status).toBe("awaiting_selection_confirm");
    const runs = listRuns(db, exhId);
    expect(runs.map((r) => r.agent_type)).toEqual(["material_steward", "aesthetic_selector"]);
    expect(runs.every((r) => r.workflow_id === body.workflow_id)).toBe(true);
    expect(runs.every((r) => r.input_revision === 0)).toBe(true);

    const res = await getStatus(new Request("http://localhost/x"), ctx(exhId) as never);
    const payload = await res.json();
    expect(payload.workflow_id).toBe(body.workflow_id);
    expect(payload.exhibition.input_revision).toBe(0);
    expect(payload.exhibition.selection_confirmed_revision).toBeNull();
    expect(payload.runs[0].workflow_id).toBe(body.workflow_id);
  });

  it("未确认选片时运行主题发现 → 409 selection_not_confirmed", async () => {
    const { status, body } = await post(postMotifs);
    expect(status).toBe(409);
    expect(body.error.code).toBe("selection_not_confirmed");
  });
});

describe("UX-1 确认选片 POST /curation/confirm", () => {
  it("expected_revision 不匹配 → 409 revision_conflict", async () => {
    const { status, body } = await post(postConfirm, { expected_revision: 99 });
    expect(status).toBe(409);
    expect(body.error.code).toBe("revision_conflict");
  });

  it("确认（exclude hold）：只纳入 keep/must_keep，跑 motifs 停在主题门", async () => {
    decide(photoIds[0], "keep");
    decide(photoIds[1], "hold");
    decide(photoIds[2], "remove");
    setUserOverride(db, exhId, photoIds[2], "must_keep");

    const rev = getExhibition(db, exhId)!.input_revision;
    const { status, body } = await post(postConfirm, {
      expected_revision: rev,
      hold_policy: "exclude",
      request_id: "req_confirm_1",
    });
    expect(status).toBe(200);
    expect(body.revision).toBe(rev + 1);
    expect(body.confirmed_photo_ids.sort()).toEqual([photoIds[0], photoIds[2]].sort());
    expect(body.workflow_id).toMatch(/^wf_/);
    expect(body.operation_id).toMatch(/^op_/);
    await waitDone();

    const exh = getExhibition(db, exhId)!;
    expect(exh.status).toBe("awaiting_theme_choice");
    expect(exh.selection_confirmed_revision).toBe(rev + 1);
    expect(exh.selection_hold_policy).toBe("exclude");
    expect(exh.selection_confirmed_photo_ids!.sort()).toEqual([photoIds[0], photoIds[2]].sort());
    // hold 照片不被悄悄改动
    const hold = listDecisions(db, exhId).find((d) => d.photo_id === photoIds[1])!;
    expect(hold.effective_decision).toBe("hold");
    expect(hold.user_override).toBeNull();
    // 操作历史落库
    const op = db.prepare("SELECT * FROM curation_operations WHERE id=?").get(body.operation_id) as {
      action: string; request_id: string; revision: number;
    };
    expect(op.action).toBe("confirm_selection");
    expect(op.request_id).toBe("req_confirm_1");
    expect(op.revision).toBe(rev + 1);
  });

  it("request_id 幂等：重复提交返回同一操作，不重复 bump revision / 不重复跑 motifs", async () => {
    const before = getExhibition(db, exhId)!.input_revision;
    const runsBefore = listRuns(db, exhId).length;
    const { status, body } = await post(postConfirm, {
      expected_revision: before,
      hold_policy: "exclude",
      request_id: "req_confirm_1",
    });
    expect(status).toBe(200);
    expect(body.operation_id).toMatch(/^op_/);
    expect(body.idempotent).toBe(true);
    expect(getExhibition(db, exhId)!.input_revision).toBe(before);
    expect(listRuns(db, exhId).length).toBe(runsBefore);
  });

  it("hold_policy=include：暂缓照片纳入候选（用户显式决定），must_keep 不受影响", async () => {
    const rev = getExhibition(db, exhId)!.input_revision;
    const { status, body } = await post(postConfirm, {
      expected_revision: rev,
      hold_policy: "include",
      discover_motifs: false,
      request_id: "req_confirm_2",
    });
    expect(status).toBe(200);
    expect(body.confirmed_photo_ids.sort()).toEqual([...photoIds].sort());
    const hold = listDecisions(db, exhId).find((d) => d.photo_id === photoIds[1])!;
    expect(hold.effective_decision).toBe("keep");
    expect(hold.user_override).toBe("keep");
    const must = listDecisions(db, exhId).find((d) => d.photo_id === photoIds[2])!;
    expect(must.user_override).toBe("must_keep");
    // discover_motifs=false 不启动管线
    expect(body.workflow_id).toBeNull();
    expect(isRunning(db, exhId)).toBe(false);
  });

  it("全部移除（候选为空）→ 409 empty_selection", async () => {
    setUserOverride(db, exhId, photoIds[0], "remove");
    setUserOverride(db, exhId, photoIds[1], "remove");
    setUserOverride(db, exhId, photoIds[2], "remove");
    const rev = getExhibition(db, exhId)!.input_revision;
    const { status, body } = await post(postConfirm, { expected_revision: rev });
    expect(status).toBe(409);
    expect(body.error.code).toBe("empty_selection");
    // 恢复
    setUserOverride(db, exhId, photoIds[0], "keep");
    setUserOverride(db, exhId, photoIds[1], "hold");
    setUserOverride(db, exhId, photoIds[2], "must_keep");
  });
});

describe("UX-1 单张决定：input_revision + 统一 markStale", () => {
  it("改变保留集 → bump revision 且 stale_from=motifs（已有更早过期则保留更早）", async () => {
    const before = getExhibition(db, exhId)!.input_revision;
    const req = new Request("http://localhost/x", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "remove" }),
    });
    const res = await patchDecision(req, ctx(exhId, photoIds[0]) as never);
    expect(res.status).toBe(200);
    const exh = getExhibition(db, exhId)!;
    expect(exh.input_revision).toBe(before + 1);
    expect(exh.stale_from).toBe("motifs");

    // 再来一次不改变保留集的覆盖（remove→remove 之外：hold→hold 不行，用 must_keep→keep 仍改集）
    // 用布局级过期测试合并：先手工标 layout 更早？motifs 比 layout 早，应保留 motifs。
    const req2 = new Request("http://localhost/x", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "keep" }),
    });
    await patchDecision(req2, ctx(exhId, photoIds[0]) as never);
    expect(getExhibition(db, exhId)!.stale_from).toBe("motifs");
  });
});
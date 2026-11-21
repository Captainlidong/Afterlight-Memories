import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { setupCuratedExhibition, resetDecisions, type CuratedFixture } from "../helpers/curatedExhibition";
import { getExhibition, createExhibition } from "@/lib/db/repos";
import { getDecision, setUserOverride, upsertAiDecision } from "@/lib/db/curation";
import { listOperations } from "@/lib/db/curationOperations";
import { listRuns, createRun } from "@/lib/db/runs";
import { insertPhotoAsset } from "@/lib/db/photos";
import { markStale } from "@/lib/orchestrator/rerunMatrix";
import { CreateExhibitionInput } from "@/lib/agents/schemas";
import { newId } from "@/lib/id";
import { POST as postBatch } from "@/app/api/exhibitions/[id]/curation/batch/route";
import { GET as getCuration } from "@/app/api/exhibitions/[id]/curation/route";
import { POST as postConfirm } from "@/app/api/exhibitions/[id]/curation/confirm/route";
import { PATCH as patchDecision } from "@/app/api/exhibitions/[id]/photos/[photoId]/decision/route";

let fx: CuratedFixture;
let p: string[];
let confirmSeq = 0;

const BASE_AI = ["keep", "keep", "hold", "hold", "remove", "remove"] as const;

async function batch(body: Record<string, unknown>, exhId?: string) {
  const id = exhId ?? fx.exhId;
  const req = new Request(`http://localhost/api/exhibitions/${id}/curation/batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await postBatch(req, { params: Promise.resolve({ id }) } as never);
  return { status: res.status, body: await res.json() };
}

function batchBody(ids: string[], extra: Record<string, unknown> = {}) {
  return {
    photo_ids: ids,
    action: "set_decision",
    decision: "hold",
    include_must_keep: false,
    expected_revision: getExhibition(fx.db, fx.exhId)!.input_revision,
    ...extra,
  };
}

async function confirm(discoverMotifs = false) {
  const rev = getExhibition(fx.db, fx.exhId)!.input_revision;
  const req = new Request(`http://localhost/api/exhibitions/${fx.exhId}/curation/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expected_revision: rev,
      hold_policy: "exclude",
      discover_motifs: discoverMotifs,
      request_id: `fixture_confirm_${++confirmSeq}`,
    }),
  });
  const res = await postConfirm(req, { params: Promise.resolve({ id: fx.exhId }) } as never);
  return { status: res.status, body: await res.json() };
}

async function patch(pid: string, body: unknown) {
  const req = new Request(`http://localhost/api/exhibitions/${fx.exhId}/photos/${pid}/decision`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await patchDecision(req, { params: Promise.resolve({ id: fx.exhId, photoId: pid }) } as never);
  return { status: res.status, body: await res.json() };
}

async function getCurationPayload() {
  const res = await getCuration(new Request("http://localhost/x"), { params: Promise.resolve({ id: fx.exhId }) } as never);
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  fx = await setupCuratedExhibition(6);
  p = fx.photoIds;
});

beforeEach(() => {
  resetDecisions(fx.db, fx.exhId, p, [...BASE_AI]);
});

afterAll(() => {
  fx.cleanup();
});

describe("POST /curation/batch — set_decision（§19.5）", () => {
  it("批量暂缓：一次事务写覆盖，revision+1、一条操作历史、ai_decision 不变、不调模型", async () => {
    const revBefore = getExhibition(fx.db, fx.exhId)!.input_revision;
    const runsBefore = listRuns(fx.db, fx.exhId).length;
    const { status, body } = await batch(batchBody([p[0], p[1]]));
    expect(status).toBe(200);
    expect([...body.changed_ids].sort()).toEqual([p[0], p[1]].sort());
    expect(body.skipped_ids).toEqual([]);
    expect(body.skipped_reason).toBeNull();
    expect(body.revision).toBe(revBefore + 1);
    expect(body.counts).toEqual({ keep: 0, hold: 4, remove: 2, must_keep: 0 });
    expect(body.next_action).toBe("confirm_selection");
    expect(body.operation_id).toMatch(/^op_/);
    expect(body.idempotent).toBe(false);
    const d0 = getDecision(fx.db, p[0])!;
    expect(d0.user_override).toBe("hold");
    expect(d0.ai_decision).toBe("keep");
    expect(getExhibition(fx.db, fx.exhId)!.input_revision).toBe(revBefore + 1);
    const ops = listOperations(fx.db, fx.exhId);
    expect(ops.length).toBe(1);
    expect(ops[0].action).toBe("set_decision");
    expect(ops[0].decision).toBe("hold");
    expect(listRuns(fx.db, fx.exhId).length).toBe(runsBefore);
  });

  it("批量必须保留：effective must_keep，counts.must_keep 正确，保留集扩大 → stale motifs", async () => {
    const { status, body } = await batch(batchBody([p[4]], { decision: "must_keep" }));
    expect(status).toBe(200);
    expect(getDecision(fx.db, p[4])!.effective_decision).toBe("must_keep");
    expect(body.counts.must_keep).toBe(1);
    expect(getExhibition(fx.db, fx.exhId)!.stale_from).toBe("motifs");
  });

  it("must_keep 保护：默认跳过，changed/skipped 分开反馈", async () => {
    setUserOverride(fx.db, fx.exhId, p[0], "must_keep");
    const { status, body } = await batch(batchBody([p[0], p[1]]));
    expect(status).toBe(200);
    expect(body.changed_ids).toEqual([p[1]]);
    expect(body.skipped_ids).toEqual([p[0]]);
    expect(body.skipped_reason).toBe("must_keep_protected");
    expect(getDecision(fx.db, p[0])!.effective_decision).toBe("must_keep");
  });

  it("include_must_keep=true：用户显式选择才解除保护", async () => {
    setUserOverride(fx.db, fx.exhId, p[0], "must_keep");
    const { status, body } = await batch(batchBody([p[0], p[1]], { include_must_keep: true }));
    expect(status).toBe(200);
    expect([...body.changed_ids].sort()).toEqual([p[0], p[1]].sort());
    expect(body.skipped_ids).toEqual([]);
    expect(getDecision(fx.db, p[0])!.user_override).toBe("hold");
  });

  it("普通「设为保留」不悄悄取消已有 must_keep", async () => {
    setUserOverride(fx.db, fx.exhId, p[0], "must_keep");
    const { status, body } = await batch(batchBody([p[0], p[2]], { decision: "keep" }));
    expect(status).toBe(200);
    expect(body.changed_ids).toEqual([p[2]]);
    expect(body.skipped_ids).toEqual([p[0]]);
    expect(getDecision(fx.db, p[0])!.effective_decision).toBe("must_keep");
    expect(getDecision(fx.db, p[2])!.effective_decision).toBe("keep");
  });

  it("重复 ID 去重：只改一次、只记一条操作", async () => {
    const revBefore = getExhibition(fx.db, fx.exhId)!.input_revision;
    const { status, body } = await batch(batchBody([p[2], p[2], p[3]]));
    expect(status).toBe(200);
    expect([...body.changed_ids].sort()).toEqual([p[2], p[3]].sort());
    expect(listOperations(fx.db, fx.exhId).length).toBe(1);
    expect(getExhibition(fx.db, fx.exhId)!.input_revision).toBe(revBefore + 1);
  });

  it("全部已是目标状态 → 409 nothing_to_change，零写入", async () => {
    setUserOverride(fx.db, fx.exhId, p[2], "hold");
    const revBefore = getExhibition(fx.db, fx.exhId)!.input_revision;
    const { status, body } = await batch(batchBody([p[2]]));
    expect(status).toBe(409);
    expect(body.error.code).toBe("nothing_to_change");
    expect(getExhibition(fx.db, fx.exhId)!.input_revision).toBe(revBefore);
    expect(listOperations(fx.db, fx.exhId).length).toBe(0);
  });

  it("全部被保护跳过 → 200 但无操作、不 bump revision", async () => {
    setUserOverride(fx.db, fx.exhId, p[0], "must_keep");
    setUserOverride(fx.db, fx.exhId, p[1], "must_keep");
    const revBefore = getExhibition(fx.db, fx.exhId)!.input_revision;
    const { status, body } = await batch(batchBody([p[0], p[1]]));
    expect(status).toBe(200);
    expect(body.operation_id).toBeNull();
    expect(body.changed_ids).toEqual([]);
    expect([...body.skipped_ids].sort()).toEqual([p[0], p[1]].sort());
    expect(body.skipped_reason).toBe("must_keep_protected");
    expect(body.revision).toBe(revBefore);
    expect(getExhibition(fx.db, fx.exhId)!.input_revision).toBe(revBefore);
    expect(listOperations(fx.db, fx.exhId).length).toBe(0);
  });

  it("expected_revision 不符 → 409 revision_conflict，整批拒绝", async () => {
    const revBefore = getExhibition(fx.db, fx.exhId)!.input_revision;
    const { status, body } = await batch(batchBody([p[2], p[3]], { expected_revision: 999 }));
    expect(status).toBe(409);
    expect(body.error.code).toBe("revision_conflict");
    expect(getDecision(fx.db, p[2])!.user_override).toBeNull();
    expect(getDecision(fx.db, p[3])!.user_override).toBeNull();
    expect(getExhibition(fx.db, fx.exhId)!.input_revision).toBe(revBefore);
    expect(listOperations(fx.db, fx.exhId).length).toBe(0);
  });

  it("request_id 幂等：重试返回同一操作，不重复 revision/历史", async () => {
    const revBefore = getExhibition(fx.db, fx.exhId)!.input_revision;
    const first = await batch(batchBody([p[2]], { request_id: "req_batch_1" }));
    expect(first.status).toBe(200);
    expect(first.body.idempotent).toBe(false);
    const second = await batch(batchBody([p[2]], { request_id: "req_batch_1" }));
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(second.body.operation_id).toBe(first.body.operation_id);
    expect(second.body.revision).toBe(first.body.revision);
    expect(getExhibition(fx.db, fx.exhId)!.input_revision).toBe(revBefore + 1);
    expect(listOperations(fx.db, fx.exhId).length).toBe(1);
  });

  it("不存在的照片 ID → 整批拒绝，合法照片也不改", async () => {
    const { status, body } = await batch(batchBody([p[2], "photo_nope"]));
    expect(status).toBe(409);
    expect(body.error.code).toBe("invalid_photos");
    expect(getDecision(fx.db, p[2])!.user_override).toBeNull();
    expect(listOperations(fx.db, fx.exhId).length).toBe(0);
  });

  it("照片没有筛选决定 → 整批拒绝", async () => {
    fx.db.prepare("DELETE FROM curation_decisions WHERE photo_id=?").run(p[5]);
    const { status, body } = await batch(batchBody([p[4], p[5]]));
    expect(status).toBe(409);
    expect(body.error.code).toBe("invalid_photos");
    expect(getDecision(fx.db, p[4])!.user_override).toBeNull();
  });

  it("其他影展的照片 → 整批拒绝（归属校验）", async () => {
    const otherId = createExhibition(fx.db, CreateExhibitionInput.parse({}), "demo").id;
    const otherPid = newId("photo");
    insertPhotoAsset(fx.db, {
      id: otherPid, exhibition_id: otherId, original_name: "o.jpg",
      storage_path: "uploads/other/o.jpg", thumbnail_path: "uploads/other/thumb_o.jpg",
      width: 100, height: 80, mime_type: "image/jpeg",
      file_size: 100, sha256: "x", sort_order: 0,
    });
    upsertAiDecision(fx.db, otherId, {
      photo_id: otherPid, decision: "keep", score: 0.7, confidence: 0.8,
      reasons: ["测试"], related_photo_ids: [], user_override_allowed: true,
    });
    const { status, body } = await batch(batchBody([p[2], otherPid]));
    expect(status).toBe(409);
    expect(body.error.code).toBe("invalid_photos");
    expect(getDecision(fx.db, p[2])!.user_override).toBeNull();
  });

  it("set_decision 缺 decision → 400 validation_error", async () => {
    const { status, body } = await batch({
      photo_ids: [p[2]],
      action: "set_decision",
      expected_revision: getExhibition(fx.db, fx.exhId)!.input_revision,
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe("validation_error");
  });

  it("有正在运行的任务 → 409 concurrent_run", async () => {
    createRun(fx.db, {
      exhibitionId: fx.exhId, agentType: "aesthetic_selector", status: "running",
      inputVersion: 0, workflowId: newId("wf"), inputRevision: 0,
    });
    const { status, body } = await batch(batchBody([p[2]]));
    expect(status).toBe(409);
    expect(body.error.code).toBe("concurrent_run");
  });
});

describe("批量与确认门（§19.5.7）", () => {
  it("保留集改变 → 确认失效、状态回到待确认选片、stale=motifs、不跑模型", async () => {
    const c = await confirm();
    expect(c.status).toBe(200);
    expect(getExhibition(fx.db, fx.exhId)!.selection_confirmed_revision).not.toBeNull();
    const runsBefore = listRuns(fx.db, fx.exhId).length;
    const { status } = await batch(batchBody([p[0]]));
    expect(status).toBe(200);
    const exh = getExhibition(fx.db, fx.exhId)!;
    expect(exh.selection_confirmed_revision).toBeNull();
    expect(exh.selection_confirmed_photo_ids).toBeNull();
    expect(exh.selection_hold_policy).toBeNull();
    expect(exh.status).toBe("awaiting_selection_confirm");
    expect(exh.stale_from).toBe("motifs");
    expect(listRuns(fx.db, fx.exhId).length).toBe(runsBefore);
  });

  it("仅添加 must_keep（保留集不变）→ 保留确认，stale=narrative", async () => {
    const c = await confirm();
    const confirmedRev = c.body.revision;
    const { status } = await batch(batchBody([p[0]], { decision: "must_keep" }));
    expect(status).toBe(200);
    const exh = getExhibition(fx.db, fx.exhId)!;
    expect(exh.selection_confirmed_revision).toBe(confirmedRev);
    expect(exh.stale_from).toBe("narrative");
    expect(exh.status).toBe("awaiting_selection_confirm");
  });

  it("hold→remove（保留集外变化）→ 保留确认，stale=narrative", async () => {
    const c = await confirm();
    const confirmedRev = c.body.revision;
    const { status } = await batch(batchBody([p[2]], { decision: "remove" }));
    expect(status).toBe(200);
    const exh = getExhibition(fx.db, fx.exhId)!;
    expect(exh.selection_confirmed_revision).toBe(confirmedRev);
    expect(exh.stale_from).toBe("narrative");
  });

  it("已有 stale=narrative + 保留集改变 → 合并为更早的 motifs", async () => {
    markStale(fx.db, fx.exhId, "narrative");
    const { status } = await batch(batchBody([p[0]]));
    expect(status).toBe(200);
    expect(getExhibition(fx.db, fx.exhId)!.stale_from).toBe("motifs");
  });
});

describe("POST /curation/batch — restore_ai_suggestion", () => {
  it("恢复 AI 建议：覆盖置 null（不是复制 AI 决定），默认跳过 must_keep", async () => {
    setUserOverride(fx.db, fx.exhId, p[2], "keep", "用户理由");
    setUserOverride(fx.db, fx.exhId, p[3], "must_keep");
    const { status, body } = await batch(batchBody([p[2], p[3]], { action: "restore_ai_suggestion", decision: undefined }));
    expect(status).toBe(200);
    expect(body.changed_ids).toEqual([p[2]]);
    expect(body.skipped_ids).toEqual([p[3]]);
    expect(body.skipped_reason).toBe("must_keep_protected");
    const d2 = getDecision(fx.db, p[2])!;
    expect(d2.user_override).toBeNull();
    expect(d2.override_reason).toBeNull();
    expect(d2.effective_decision).toBe("hold");
    expect(d2.ai_decision).toBe("hold");
    expect(getDecision(fx.db, p[3])!.effective_decision).toBe("must_keep");
    const op = listOperations(fx.db, fx.exhId)[0];
    expect(op.action).toBe("restore_ai_suggestion");
    expect(op.decision).toBeNull();
  });

  it("include_must_keep=true → 解除保护恢复 AI 建议", async () => {
    setUserOverride(fx.db, fx.exhId, p[3], "must_keep");
    const { status, body } = await batch(batchBody([p[3]], { action: "restore_ai_suggestion", decision: undefined, include_must_keep: true }));
    expect(status).toBe(200);
    expect(body.changed_ids).toEqual([p[3]]);
    expect(getDecision(fx.db, p[3])!.user_override).toBeNull();
    expect(getDecision(fx.db, p[3])!.effective_decision).toBe("hold");
  });

  it("全部没有覆盖 → 409 nothing_to_change", async () => {
    const { status, body } = await batch(batchBody([p[2], p[3]], { action: "restore_ai_suggestion", decision: undefined }));
    expect(status).toBe(409);
    expect(body.error.code).toBe("nothing_to_change");
  });
});

describe("GET /curation 扩展（counts/revision/latest_undoable_operation）", () => {
  it("无操作历史 → counts/revision 正确，latest_undoable_operation=null", async () => {
    const { status, body } = await getCurationPayload();
    expect(status).toBe(200);
    expect(body.decisions.length).toBe(6);
    expect(body.counts).toEqual({ keep: 2, hold: 2, remove: 2, must_keep: 0 });
    expect(body.revision).toBe(getExhibition(fx.db, fx.exhId)!.input_revision);
    expect(body.latest_undoable_operation).toBeNull();
  });

  it("批量后 → latest_undoable_operation 指向该操作", async () => {
    const { body } = await batch(batchBody([p[2]]));
    const { body: payload } = await getCurationPayload();
    expect(payload.latest_undoable_operation).not.toBeNull();
    expect(payload.latest_undoable_operation.id).toBe(body.operation_id);
    expect(payload.latest_undoable_operation.action).toBe("set_decision");
    expect(payload.latest_undoable_operation.photo_ids).toEqual([p[2]]);
    expect(payload.counts.hold).toBe(2);
  });

  it("最新操作是 confirm_selection → null（确认不可经此入口撤销）", async () => {
    await batch(batchBody([p[2]]));
    await confirm();
    const { body } = await getCurationPayload();
    expect(body.latest_undoable_operation).toBeNull();
  });

  it("批量后单张 PATCH 改了状态 → 快照不一致 → null", async () => {
    await batch(batchBody([p[2]]));
    const r = await patch(p[2], { decision: "keep" });
    expect(r.status).toBe(200);
    const { body } = await getCurationPayload();
    expect(body.latest_undoable_operation).toBeNull();
  });
});
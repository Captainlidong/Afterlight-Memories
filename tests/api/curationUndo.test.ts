import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { setupCuratedExhibition, resetDecisions, type CuratedFixture } from "../helpers/curatedExhibition";
import { getExhibition, createExhibition } from "@/lib/db/repos";
import { getDecision, setUserOverride } from "@/lib/db/curation";
import { getOperation, listOperations } from "@/lib/db/curationOperations";
import { listRuns } from "@/lib/db/runs";
import { CreateExhibitionInput } from "@/lib/agents/schemas";
import { POST as postBatch } from "@/app/api/exhibitions/[id]/curation/batch/route";
import { POST as postUndo } from "@/app/api/exhibitions/[id]/curation/operations/[opId]/undo/route";
import { POST as postConfirm } from "@/app/api/exhibitions/[id]/curation/confirm/route";

let fx: CuratedFixture;
let p: string[];
let otherExhId: string;
let seq = 0;

const BASE_AI = ["keep", "keep", "hold", "hold", "remove", "remove"] as const;

async function batch(ids: string[], extra: Record<string, unknown> = {}) {
  const body = {
    photo_ids: ids,
    action: "set_decision",
    decision: "hold",
    include_must_keep: false,
    expected_revision: getExhibition(fx.db, fx.exhId)!.input_revision,
    request_id: `fixture_batch_${++seq}`,
    ...extra,
  };
  const req = new Request(`http://localhost/api/exhibitions/${fx.exhId}/curation/batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await postBatch(req, { params: Promise.resolve({ id: fx.exhId }) } as never);
  return { status: res.status, body: await res.json() };
}

async function undo(opId: string, exhId?: string) {
  const id = exhId ?? fx.exhId;
  const req = new Request(`http://localhost/api/exhibitions/${id}/curation/operations/${opId}/undo`, {
    method: "POST",
  });
  const res = await postUndo(req, { params: Promise.resolve({ id, opId }) } as never);
  return { status: res.status, body: await res.json() };
}

async function confirm() {
  const rev = getExhibition(fx.db, fx.exhId)!.input_revision;
  const req = new Request(`http://localhost/api/exhibitions/${fx.exhId}/curation/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expected_revision: rev,
      hold_policy: "exclude",
      discover_motifs: false,
      request_id: `fixture_confirm_${++seq}`,
    }),
  });
  const res = await postConfirm(req, { params: Promise.resolve({ id: fx.exhId }) } as never);
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  fx = await setupCuratedExhibition(6);
  p = fx.photoIds;
  otherExhId = createExhibition(fx.db, CreateExhibitionInput.parse({}), "demo").id;
});

beforeEach(() => {
  resetDecisions(fx.db, fx.exhId, p, [...BASE_AI]);
});

afterAll(() => {
  fx.cleanup();
});

describe("POST /curation/operations/{opId}/undo（§19.5 撤销）", () => {
  it("恢复实际改变照片的原覆盖与原因；被跳过照片不动", async () => {
    setUserOverride(fx.db, fx.exhId, p[2], "keep", "我想留下这张");
    setUserOverride(fx.db, fx.exhId, p[0], "must_keep");
    const b = await batch([p[0], p[2], p[3]]);
    expect(b.status).toBe(200);
    expect([...b.body.changed_ids].sort()).toEqual([p[2], p[3]].sort());
    const { status, body } = await undo(b.body.operation_id);
    expect(status).toBe(200);
    expect(body.idempotent).toBe(false);
    expect([...body.restored_ids].sort()).toEqual([p[2], p[3]].sort());
    const d2 = getDecision(fx.db, p[2])!;
    expect(d2.user_override).toBe("keep");
    expect(d2.override_reason).toBe("我想留下这张");
    expect(getDecision(fx.db, p[3])!.user_override).toBeNull();
    expect(getDecision(fx.db, p[0])!.effective_decision).toBe("must_keep");
    expect(getOperation(fx.db, b.body.operation_id)!.undone).toBe(true);
  });

  it("撤销 bump 一次 revision、正确使下游失效、不触发模型", async () => {
    const b = await batch([p[0]]);
    const revAfterBatch = getExhibition(fx.db, fx.exhId)!.input_revision;
    const runsBefore = listRuns(fx.db, fx.exhId).length;
    const { status, body } = await undo(b.body.operation_id);
    expect(status).toBe(200);
    expect(body.revision).toBe(revAfterBatch + 1);
    expect(getExhibition(fx.db, fx.exhId)!.input_revision).toBe(revAfterBatch + 1);
    expect(getExhibition(fx.db, fx.exhId)!.stale_from).toBe("motifs");
    expect(getDecision(fx.db, p[0])!.effective_decision).toBe("keep");
    expect(body.counts).toEqual({ keep: 2, hold: 2, remove: 2, must_keep: 0 });
    expect(listRuns(fx.db, fx.exhId).length).toBe(runsBefore);
  });

  it("网络重试幂等：第二次撤销成功且不再 bump revision", async () => {
    const b = await batch([p[2]]);
    const first = await undo(b.body.operation_id);
    expect(first.status).toBe(200);
    const revAfter = getExhibition(fx.db, fx.exhId)!.input_revision;
    const second = await undo(b.body.operation_id);
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(second.body.operation_id).toBe(b.body.operation_id);
    expect(getExhibition(fx.db, fx.exhId)!.input_revision).toBe(revAfter);
    expect(getDecision(fx.db, p[2])!.user_override).toBeNull();
  });

  it("后续批量覆盖 → 409 operation_superseded，只能撤销最新", async () => {
    const b1 = await batch([p[2]]);
    const b2 = await batch([p[3]], { decision: "keep" });
    const r1 = await undo(b1.body.operation_id);
    expect(r1.status).toBe(409);
    expect(r1.body.error.code).toBe("operation_superseded");
    const r2 = await undo(b2.body.operation_id);
    expect(r2.status).toBe(200);
  });

  it("后续确认选片 → 409 operation_superseded", async () => {
    const b = await batch([p[0]], { decision: "must_keep" });
    const c = await confirm();
    expect(c.status).toBe(200);
    const r = await undo(b.body.operation_id);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("operation_superseded");
  });

  it("后续单张编辑（无操作历史）→ 409 operation_conflict，不回滚后来的修改", async () => {
    const b = await batch([p[2], p[3]]);
    setUserOverride(fx.db, fx.exhId, p[2], "keep");
    const r = await undo(b.body.operation_id);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("operation_conflict");
    expect(getDecision(fx.db, p[2])!.user_override).toBe("keep");
    expect(getDecision(fx.db, p[3])!.user_override).toBe("hold");
    expect(getOperation(fx.db, b.body.operation_id)!.undone).toBe(false);
  });

  it("跨影展撤销 → 404（归属校验）", async () => {
    const b = await batch([p[2]]);
    const r = await undo(b.body.operation_id, otherExhId);
    expect(r.status).toBe(404);
    expect(getDecision(fx.db, p[2])!.user_override).toBe("hold");
  });

  it("不存在的操作 → 404", async () => {
    const r = await undo("op_nope");
    expect(r.status).toBe(404);
  });

  it("confirm_selection 操作 → 409 not_undoable", async () => {
    const c = await confirm();
    const r = await undo(c.body.operation_id);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("not_undoable");
  });

  it("撤销保留集变化不自动恢复确认（需用户重新确认）", async () => {
    await confirm();
    const b = await batch([p[0]]);
    expect(getExhibition(fx.db, fx.exhId)!.selection_confirmed_revision).toBeNull();
    const r = await undo(b.body.operation_id);
    expect(r.status).toBe(200);
    const exh = getExhibition(fx.db, fx.exhId)!;
    expect(exh.selection_confirmed_revision).toBeNull();
    expect(exh.status).toBe("awaiting_selection_confirm");
    expect(exh.stale_from).toBe("motifs");
    expect(getDecision(fx.db, p[0])!.effective_decision).toBe("keep");
  });

  it("撤销 restore_ai_suggestion → 找回用户覆盖与原因", async () => {
    setUserOverride(fx.db, fx.exhId, p[2], "keep", "理由");
    const b = await batch([p[2]], { action: "restore_ai_suggestion", decision: undefined });
    expect(b.status).toBe(200);
    expect(getDecision(fx.db, p[2])!.user_override).toBeNull();
    const r = await undo(b.body.operation_id);
    expect(r.status).toBe(200);
    const d = getDecision(fx.db, p[2])!;
    expect(d.user_override).toBe("keep");
    expect(d.override_reason).toBe("理由");
  });

  it("照片决定已不存在（照片被删）→ 409 operation_conflict，不恢复已删除文件", async () => {
    const b = await batch([p[2]]);
    fx.db.prepare("DELETE FROM curation_decisions WHERE photo_id=?").run(p[2]);
    const r = await undo(b.body.operation_id);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("operation_conflict");
    expect(listOperations(fx.db, fx.exhId).length).toBe(1);
  });
});
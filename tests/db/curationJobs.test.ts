import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createDb } from "@/lib/db/client";
import { createExhibition, getExhibition, bumpInputRevision } from "@/lib/db/repos";
import { CreateExhibitionInput } from "@/lib/agents/schemas";
import { ensureCurationJob, bindCurationWorkflow, getCurationJob } from "@/lib/db/curationJobs";
import { reserveAiCall, getBudgetUsage, markAiCallSent, releaseAiReservation } from "@/lib/ai/budget";
import { createAiCall, listAiCalls } from "@/lib/ai/records";
import { MIGRATIONS, migrate } from "@/lib/db/migrations";
import { assertExternalSendAllowed } from "@/lib/ai/policy";
import type { AiCallContext } from "@/lib/ai/policy";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const handles: DatabaseSync[] = [];
const dirs: string[] = [];
afterEach(() => { handles.forEach(db => db.close()); handles.length = 0; dirs.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })); dirs.length = 0; });
const limits = { maxCallsPerJob: 2, maxCallsPerDay: 100, connectionTestLimitPerHour: 5, dayTimezone: "UTC" };
function setup(file = ":memory:") {
  const db = createDb(file); handles.push(db);
  const exh = createExhibition(db, CreateExhibitionInput.parse({ allow_external_ai: true }), "ai");
  return { db, exh };
}
const call = (exhibitionId: string, workflowId = "wf_a") => ({ exhibitionId, workflowId, scopeType: "workflow" as const, scopeId: workflowId, purpose: "vision" as const, provider: "openai-compatible", model: "mock" });

describe("持久策展任务", () => {
  it("同影展跨 workflow/revision 沿用任务及初始上限，不影响其他影展", () => {
    const { db, exh } = setup();
    const first = ensureCurationJob(db, exh.id, 2);
    bumpInputRevision(db, exh.id);
    expect(ensureCurationJob(db, exh.id, 100)).toEqual(first);
    const other = createExhibition(db, CreateExhibitionInput.parse({}), "ai");
    expect(ensureCurationJob(db, other.id, 3).id).not.toBe(first.id);
    expect(first.max_calls).toBe(2);
  });

  it("服务端关联冻结当前 revision/照片集，旧 revision 不允许外发", () => {
    const { db, exh } = setup();
    const bound = bindCurationWorkflow(db, exh, "wf_bound", 2);
    const context: AiCallContext = { ...call(exh.id, "wf_bound"), promptVersion: "v1", schemaVersion: "v1" };
    expect(bound.curation_job_id).toBe(getCurationJob(db, exh.id)!.id);
    expect(bound.photo_ids).toEqual([]);
    expect(bound.input_revision).toBe(exh.input_revision);
    expect(() => assertExternalSendAllowed(db, context)).not.toThrow();
    bumpInputRevision(db, exh.id);
    expect(() => assertExternalSendAllowed(db, context)).toThrow();
    const next = bindCurationWorkflow(db, getExhibition(db, exh.id)!, "wf_next", 100);
    expect(next.curation_job_id).toBe(bound.curation_job_id);
    expect(next.input_revision).toBe(exh.input_revision + 1);
  });

  it("同 revision 偷换照片集或影展归属也不能使用旧 workflow 外发", () => {
    const { db, exh } = setup();
    bindCurationWorkflow(db, exh, "wf_photos", 2);
    const context: AiCallContext = { ...call(exh.id, "wf_photos"), promptVersion: "v1", schemaVersion: "v1" };
    db.prepare(`INSERT INTO photo_assets (id, exhibition_id, original_name, storage_path, mime_type, file_size, sha256, created_at)
      VALUES ('added', ?, 'test.jpg', 'uploads/test.jpg', 'image/jpeg', 1, 'hash', '2026-11-20')`).run(exh.id);
    expect(() => assertExternalSendAllowed(db, context)).toThrow(/输入范围或版本已变化/);
    const other = createExhibition(db, CreateExhibitionInput.parse({ allow_external_ai: true }), "ai");
    expect(() => assertExternalSendAllowed(db, { ...context, exhibitionId: other.id })).toThrow(/输入范围或版本已变化/);
  });

  it("配置调低立即收紧额度，历史 released 不纳入首次计数", () => {
    const { db, exh } = setup();
    const released = createAiCall(db, call(exh.id));
    db.prepare("UPDATE ai_calls SET status='released' WHERE id=?").run(released.id);
    reserveAiCall(db, call(exh.id), limits);
    expect(getBudgetUsage(db, { scopeType: "job" })).toBe(1);
    expect(() => reserveAiCall(db, call(exh.id, "wf_lower"), { ...limits, maxCallsPerJob: 1 })).toThrow(/策展任务/);
    expect(getCurationJob(db, exh.id)!.max_calls).toBe(2);
  });

  it("伪造 workflow 或 job scope 不能获得同影展的新总额", () => {
    const { db, exh } = setup();
    reserveAiCall(db, call(exh.id), limits, new Date("2026-11-20"));
    reserveAiCall(db, { ...call(exh.id, "wf_b"), scopeType: "job", scopeId: "untrusted-job" }, limits, new Date("2026-11-21"));
    expect(() => reserveAiCall(db, call(exh.id, "wf_c"), { ...limits, maxCallsPerJob: 100 }, new Date("2026-11-22"))).toThrow(/策展任务/);
    expect(listAiCalls(db)).toHaveLength(2);
    expect(getBudgetUsage(db, { scopeType: "job", scopeId: getCurationJob(db, exh.id)!.id })).toBe(2);
  });

  it("旧外发记录引入总额，升级与幂等迁移不改旧记录", () => {
    const db = new DatabaseSync(":memory:"); handles.push(db);
    for (const sql of MIGRATIONS.slice(0, 7)) db.exec(sql);
    db.exec("PRAGMA user_version=7");
    const exh = createExhibition(db, CreateExhibitionInput.parse({ allow_external_ai: true }), "ai");
    const old = createAiCall(db, call(exh.id));
    db.prepare("UPDATE ai_calls SET status='failed' WHERE id=?").run(old.id);
    const before = listAiCalls(db);
    migrate(db); migrate(db);
    ensureCurationJob(db, exh.id, 1);
    expect(() => reserveAiCall(db, call(exh.id, "wf_new"), limits)).toThrow(/策展任务/);
    expect(listAiCalls(db)).toEqual(before);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it("两个数据库连接顺序访问共享最后名额，退款最多一次", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-job-shared-")); dirs.push(dir);
    const file = path.join(dir, "test.db");
    const { db, exh } = setup(file);
    const second = createDb(file); handles.push(second);
    const cap = { ...limits, maxCallsPerJob: 1 };
    const reserved = reserveAiCall(db, call(exh.id, "wf_first"), cap);
    expect(() => reserveAiCall(second, call(exh.id, "wf_second"), cap)).toThrow(/策展任务/);
    expect(releaseAiReservation(second, reserved.id)).toBe(true);
    expect(releaseAiReservation(db, reserved.id)).toBe(false);
    const accepted = reserveAiCall(second, call(exh.id, "wf_second"), cap);
    markAiCallSent(second, accepted.id);
    expect(releaseAiReservation(db, accepted.id)).toBe(false);
    expect(() => reserveAiCall(db, call(exh.id, "wf_third"), cap)).toThrow(/策展任务/);
  });

  it("重开数据库保留总额；已发出不退，已释放不得再次标发出", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-job-budget-")); dirs.push(dir);
    const file = path.join(dir, "test.db");
    const { db, exh } = setup(file);
    const first = reserveAiCall(db, call(exh.id), limits);
    markAiCallSent(db, first.id);
    expect(releaseAiReservation(db, first.id)).toBe(false);
    const unused = reserveAiCall(db, call(exh.id, "wf_unused"), limits);
    expect(releaseAiReservation(db, unused.id)).toBe(true);
    expect(releaseAiReservation(db, unused.id)).toBe(false);
    expect(() => markAiCallSent(db, unused.id)).toThrow();
    db.close(); handles.pop();
    const reopened = createDb(file); handles.push(reopened);
    const job = getCurationJob(reopened, exh.id)!;
    expect(getBudgetUsage(reopened, { scopeType: "job", scopeId: job.id })).toBe(1);
    reserveAiCall(reopened, call(exh.id, "wf_retry"), limits, new Date("2026-11-23"));
    expect(() => reserveAiCall(reopened, call(exh.id, "wf_again"), limits, new Date("2026-11-24"))).toThrow(/策展任务/);
  });
});

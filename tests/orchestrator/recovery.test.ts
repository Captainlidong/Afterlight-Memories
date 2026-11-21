import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { HEARTBEAT_MS } from "@/lib/orchestrator/recovery";
import { reserveAiCall, getBudgetUsage } from "@/lib/ai/budget";
import { getAiCall } from "@/lib/ai/records";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "@/lib/db/client";
import { createExhibition, getExhibition } from "@/lib/db/repos";
import { createRun, getRun } from "@/lib/db/runs";
import { CreateExhibitionInput } from "@/lib/agents/schemas";
import {
  acquireLease,
  ensureExecutionOwner,
  recoverOrphanedTasks,
  releaseLease,
} from "@/lib/orchestrator/recovery";
import { startPipeline, isRunning } from "@/lib/orchestrator/orchestrator";
import type { DatabaseSync } from "node:sqlite";

const iso = (ms: number) => new Date(ms).toISOString();
const DEAD_PID = 2_147_483_647;

let tmp: string;

function seedRunning(db: DatabaseSync, exhId: string, agent: "narrative_editor" | "material_steward") {
  return createRun(db, {
    exhibitionId: exhId,
    agentType: agent,
    status: "running",
    inputVersion: 0,
    workflowId: "wf_crashed",
    inputRevision: 0,
  });
}

function insertLease(
  db: DatabaseSync,
  p: { exhId: string; runId: string; ownerId: string; pid: number; heartbeatAt: number },
) {
  db.prepare(
    `INSERT INTO task_leases
       (exhibition_id, owner_id, owner_pid, run_id, workflow_id, acquired_at, heartbeat_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    p.exhId,
    p.ownerId,
    p.pid,
    p.runId,
    "wf_crashed",
    iso(p.heartbeatAt),
    iso(p.heartbeatAt),
    iso(p.heartbeatAt + 60_000),
  );
}

async function waitDone(exhId: string, timeout = 8000): Promise<void> {
  const start = Date.now();
  while (isRunning(db, exhId)) {
    if (Date.now() - start > timeout) throw new Error("pipeline 超时");
    await new Promise((r) => setTimeout(r, 20));
  }
}

let db: DatabaseSync;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-recovery-"));
  db = createDb(":memory:");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("S09 lease expiration and restart", () => {
  it.each(["expired", "invalid"])("本 owner/workflow 的 %s expires_at 也无发布权，心跳不可复活", (kind) => {
    vi.useFakeTimers();
    const id = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    const run = seedRunning(db, id, "material_steward");
    try {
      acquireLease(db, { exhibitionId: id, runId: run.id, workflowId: "wf_crashed" });
      db.prepare("UPDATE task_leases SET expires_at=? WHERE exhibition_id=?").run(kind === "expired" ? iso(Date.now() - 1) : "invalid", id);
      expect(ensureExecutionOwner(db, id, "wf_crashed")).toBe(false);
      vi.advanceTimersByTime(HEARTBEAT_MS);
      expect(ensureExecutionOwner(db, id, "wf_crashed")).toBe(false);
      expect(recoverOrphanedTasks(db).reclaimed_leases).toBe(1);
      expect(getRun(db, run.id)!.status).toBe("failed");
    } finally {
      releaseLease(db, id, run.id);
      db.prepare("DELETE FROM exhibitions WHERE id=?").run(id);
      vi.useRealTimers();
    }
  });

  it("旧 run 释放不会停止新 run 心跳", () => {
    vi.useFakeTimers();
    const id = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    const run = seedRunning(db, id, "material_steward");
    const next = seedRunning(db, id, "material_steward");
    try {
      acquireLease(db, { exhibitionId: id, runId: run.id, workflowId: "old" });
      acquireLease(db, { exhibitionId: id, runId: next.id, workflowId: "new" });
      releaseLease(db, id, run.id);
      vi.advanceTimersByTime(120_000);
      const lease = db.prepare("SELECT heartbeat_at FROM task_leases WHERE exhibition_id=?").get(id) as { heartbeat_at: string };
      expect(Date.parse(lease.heartbeat_at)).toBe(Date.now());
      expect(ensureExecutionOwner(db, id, "new")).toBe(true);
    } finally {
      releaseLease(db, id, next.id);
      db.prepare("DELETE FROM exhibitions WHERE id=?").run(id);
      vi.useRealTimers();
    }
  });

  it("回收旧 workflow 的 lease 不得中断较新的 run 或覆盖其影展状态", () => {
    const id = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    const old = seedRunning(db, id, "material_steward");
    const fresh = createRun(db, { exhibitionId: id, agentType: "narrative_editor", status: "running",
      inputVersion: 0, workflowId: "fresh-workflow", inputRevision: 0 });
    insertLease(db, { exhId: id, runId: old.id, ownerId: "dead", pid: DEAD_PID, heartbeatAt: Date.now() - 120_000 });
    db.prepare("UPDATE exhibitions SET status='writing' WHERE id=?").run(id);
    try {
      recoverOrphanedTasks(db);
      expect(getRun(db, old.id)!.status).toBe("failed");
      expect(getRun(db, fresh.id)!.status).toBe("running");
      expect(getExhibition(db, id)!.status).toBe("writing");
    } finally { db.prepare("DELETE FROM exhibitions WHERE id=?").run(id); }
  });

  it("重启后 sent 未知结果保守占额，不伪造成功或退额", () => {
    const file = path.join(tmp, "sent-restart.db");
    const first = createDb(file);
    const id = createExhibition(first, CreateExhibitionInput.parse({}), "demo").id;
    const run = seedRunning(first, id, "material_steward");
    const date = new Date(Date.now() - 600_000);
    const call = reserveAiCall(first, {
      exhibitionId: id, scopeType: "workflow", scopeId: "wf_crashed",
      provider: "openai-compatible", model: "mock", purpose: "vision",
    }, { maxCallsPerJob: 40, maxCallsPerDay: 100, connectionTestLimitPerHour: 5, dayTimezone: "UTC" }, date);
    first.prepare("UPDATE ai_calls SET status='sent' WHERE id=?").run(call.id);
    const usage = getBudgetUsage(first);
    first.close();
    const restarted = createDb(file);
    try {
      expect(getAiCall(restarted, call.id)!.status).toBe("sent");
      expect(getBudgetUsage(restarted)).toBe(usage);
      expect(getRun(restarted, run.id)!.status).toBe("failed");
    } finally { restarted.close(); }
  });
});

describe("R03 租约回收", () => {
  it("失活 owner 的租约被回收：running 行标记中断、影展可解释地失败", () => {
    const exhId = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    const run = seedRunning(db, exhId, "narrative_editor");
    insertLease(db, { exhId, runId: run.id, ownerId: "owner-dead", pid: DEAD_PID, heartbeatAt: Date.now() - 120_000 });

    const res = recoverOrphanedTasks(db);
    expect(res.reclaimed_leases).toBe(1);
    expect(res.interrupted_runs).toBe(1);
    const runAfter = getRun(db, run.id)!;
    expect(runAfter.status).toBe("failed");
    expect(runAfter.error_message).toContain("[interrupted]");
    const exh = getExhibition(db, exhId)!;
    expect(exh.status).toBe("stage_failed");
    expect(exh.failed_stage).toBe("narrative");
    expect((db.prepare("SELECT COUNT(*) AS n FROM task_leases").get() as { n: number }).n).toBe(0);
  });

  it("活跃且心跳新鲜的租约不被回收（不误伤并发执行者）", () => {
    const exhId = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    const run = seedRunning(db, exhId, "material_steward");
    insertLease(db, { exhId, runId: run.id, ownerId: "owner-other", pid: process.pid, heartbeatAt: Date.now() });

    const res = recoverOrphanedTasks(db);
    expect(res.reclaimed_leases).toBe(0);
    expect(res.interrupted_runs).toBe(0);
    expect(getRun(db, run.id)!.status).toBe("running");
    expect(getExhibition(db, exhId)!.status).not.toBe("stage_failed");
  });

  it("心跳过期即使进程存活也回收（卡死执行者的看门狗）", () => {
    const exhId = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    const run = seedRunning(db, exhId, "material_steward");
    insertLease(db, { exhId, runId: run.id, ownerId: "owner-other", pid: process.pid, heartbeatAt: Date.now() - 40_000 });

    const res = recoverOrphanedTasks(db);
    expect(res.reclaimed_leases).toBe(1);
    expect(getRun(db, run.id)!.status).toBe("failed");
  });

  it("运行期不扫无租约行；启动恢复才扫（避免误伤测试/手工 running 行）", () => {
    const exhId = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    const run = seedRunning(db, exhId, "material_steward");

    expect(recoverOrphanedTasks(db).interrupted_runs).toBe(0);
    expect(getRun(db, run.id)!.status).toBe("running");

    const res = recoverOrphanedTasks(db, { includeUnleasedRuns: true });
    expect(res.interrupted_runs).toBe(1);
    expect(getRun(db, run.id)!.status).toBe("failed");
    expect(getExhibition(db, exhId)!.failed_stage).toBe("ingest");
  });

  it("过期租约被接替后原 workflow 失去执行权（fencing），新触发可正常完成", async () => {
    const exhId = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    const crashed = seedRunning(db, exhId, "material_steward");
    insertLease(db, { exhId, runId: crashed.id, ownerId: "owner-dead", pid: DEAD_PID, heartbeatAt: Date.now() - 120_000 });
    expect(ensureExecutionOwner(db, exhId, "wf_crashed")).toBe(false);

    const started = startPipeline(db, exhId, "ingest", "ingest");
    expect(started.workflow_id).not.toBe("wf_crashed");
    // 新执行者持有租约期间，旧 workflow 不得再发布。
    expect(ensureExecutionOwner(db, exhId, "wf_crashed")).toBe(false);
    expect(ensureExecutionOwner(db, exhId, started.workflow_id)).toBe(true);
    await waitDone(exhId);

    expect(getRun(db, crashed.id)!.status).toBe("failed");
    expect(getRun(db, crashed.id)!.error_message).toContain("[interrupted]");
    const fresh = (db.prepare("SELECT status FROM agent_runs WHERE workflow_id=?").all(started.workflow_id) as { status: string }[]);
    expect(fresh.every((r) => r.status === "completed")).toBe(true);
    // 管线结束即释放租约。
    expect(ensureExecutionOwner(db, exhId, started.workflow_id)).toBe(false);
  });

  it("重启后 createDb 启动恢复会中断遗留 running 行（无租约遗留场景）", () => {
    const file = path.join(tmp, "restart.db");
    const db1 = createDb(file);
    const exhId = createExhibition(db1, CreateExhibitionInput.parse({}), "demo").id;
    const run = seedRunning(db1, exhId, "material_steward");
    db1.close();

    const db2 = createDb(file);
    expect(getRun(db2, run.id)!.status).toBe("failed");
    expect(getRun(db2, run.id)!.error_message).toContain("[interrupted]");
    expect(getExhibition(db2, exhId)!.status).toBe("stage_failed");
    db2.close();
  });

  it("acquireLease/releaseLease 与执行权判定配套（workflow 级）", () => {
    const exhId = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    const run = createRun(db, {
      exhibitionId: exhId, agentType: "material_steward", status: "running",
      inputVersion: 0, workflowId: "wf_own", inputRevision: 0,
    });
    acquireLease(db, { exhibitionId: exhId, runId: run.id, workflowId: "wf_own" });
    expect(ensureExecutionOwner(db, exhId, "wf_own")).toBe(true);
    expect(ensureExecutionOwner(db, exhId, "wf_other")).toBe(false);
    releaseLease(db, exhId, run.id);
    expect(ensureExecutionOwner(db, exhId, "wf_own")).toBe(false);
  });
});

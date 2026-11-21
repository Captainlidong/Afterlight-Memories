import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createDb } from "@/lib/db/client";
import {
  reserveAiCall,
  releaseAiReservation,
  releaseStaleAiReservations,
  getBudgetUsage,
  budgetPeriodsFor,
  dayKeyInTz,
  hourKeyInTz,
  type BudgetLimits,
} from "@/lib/ai/budget";
import { getAiCall, listAiCalls, type NewAiCallInput } from "@/lib/ai/records";
import { AiBudgetError } from "@/lib/ai/errors";

let db: DatabaseSync;

beforeAll(() => {
  db = createDb(":memory:");
});

afterAll(() => {
  db.close();
});

const limits: BudgetLimits = {
  maxCallsPerJob: 3,
  maxCallsPerDay: 5,
  connectionTestLimitPerHour: 2,
  dayTimezone: "Asia/Shanghai",
};

function input(overrides: Partial<NewAiCallInput> = {}): NewAiCallInput {
  return {
    exhibitionId: null,
    scopeType: "workflow",
    scopeId: "wf-1",
    provider: "openai-compatible",
    model: "vision-x",
    purpose: "vision",
    ...overrides,
  };
}

// 每个用例使用独立日期，避免共享全局日计数器互相干扰。
const D1 = new Date("2026-11-20T03:00:00.000Z");
const D2 = new Date("2026-11-21T03:00:00.000Z");
const D3 = new Date("2026-11-22T03:00:00.000Z");
const D4 = new Date("2026-11-23T03:00:00.000Z");
const D5 = new Date("2026-11-24T03:00:00.000Z");

describe("预算周期键（任务书 §7.3 统计单位）", () => {
  it("日/小时键按配置时区生成", () => {
    expect(dayKeyInTz("Asia/Shanghai", D1)).toBe("2026-11-20");
    expect(hourKeyInTz("Asia/Shanghai", D1)).toBe("2026-11-20-11");
    // 上海 11:00 = UTC+0 03:00 → 同日但小时不同
    expect(hourKeyInTz("UTC", D1)).toBe("2026-11-20-03");
  });

  it("workflow 只占全局日额；job 额外占任务总额；连接测试额外占小时额", () => {
    const wf = budgetPeriodsFor("workflow", "wf-1", limits, D1);
    expect(wf.map((p) => `${p.scopeType}:${p.periodKey}`)).toEqual(["global:2026-11-20"]);

    const job = budgetPeriodsFor("job", "job-1", limits, D1);
    expect(job.some((p) => p.scopeType === "job" && p.periodKey === "total")).toBe(true);

    const ct = budgetPeriodsFor("connection_test", "ct", limits, D1);
    expect(ct.some((p) => p.scopeType === "connection_test" && p.periodKey === "2026-11-20-11")).toBe(true);
  });
});

describe("预留 / 释放 / 保守占额", () => {
  it("预留即占额；释放未发出的预留归还名额；已发出的不可释放", () => {
    const rec = reserveAiCall(db, input({ scopeId: "wf-r1" }), limits, D1);
    expect(rec.status).toBe("reserved");
    expect(getBudgetUsage(db, { scopeType: "global", scopeId: "*", periodKey: "2026-11-20" })).toBe(1);

    expect(releaseAiReservation(db, rec.id)).toBe(true);
    expect(getAiCall(db, rec.id)!.status).toBe("released");
    expect(getBudgetUsage(db, { scopeType: "global", scopeId: "*", periodKey: "2026-11-20" })).toBe(0);

    // 已发出（sent）→ 服务商可能已计费，保守占额，释放返回 false
    const rec2 = reserveAiCall(db, input({ scopeId: "wf-r2" }), limits, D1);
    db.prepare("UPDATE ai_calls SET status='sent' WHERE id=?").run(rec2.id);
    expect(releaseAiReservation(db, rec2.id)).toBe(false);
    expect(getBudgetUsage(db, { scopeType: "global", scopeId: "*", periodKey: "2026-11-20" })).toBe(1);
  });

  it("超限本地拒绝：不落调用行、不动计数、不请求服务商", () => {
    for (let i = 0; i < 5; i++) {
      reserveAiCall(db, input({ scopeId: "wf-full" }), limits, D2);
    }
    const before = listAiCalls(db, { scopeId: "wf-full" }).length;
    expect(() => reserveAiCall(db, input({ scopeId: "wf-full" }), limits, D2)).toThrowError(AiBudgetError);
    expect(listAiCalls(db, { scopeId: "wf-full" }).length).toBe(before);
    expect(getBudgetUsage(db, { scopeType: "global", scopeId: "*", periodKey: "2026-11-21" })).toBe(5);
  });

  it("任务总额上限独立于全局日额", () => {
    const jobLimits = { ...limits, maxCallsPerJob: 2 };
    reserveAiCall(db, input({ scopeType: "job", scopeId: "job-x", exhibitionId: null }), jobLimits, D3);
    reserveAiCall(db, input({ scopeType: "job", scopeId: "job-x", exhibitionId: null }), jobLimits, D3);
    expect(() =>
      reserveAiCall(db, input({ scopeType: "job", scopeId: "job-x", exhibitionId: null }), jobLimits, D3),
    ).toThrowError(/策展任务/);
    // 其他任务不受影响
    expect(() =>
      reserveAiCall(db, input({ scopeType: "job", scopeId: "job-y", exhibitionId: null }), jobLimits, D3),
    ).not.toThrow();
  });

  it("跨自然日获得新日额：不能将每日上限当作跨日总授权", () => {
    const isolated = createDb(":memory:");
    try {
      const cap = { ...limits, maxCallsPerDay: 1 };
      const beforeMidnight = new Date("2026-11-25T15:59:59.000Z");
      const afterMidnight = new Date("2026-11-25T16:00:00.000Z");
      reserveAiCall(isolated, input(), cap, beforeMidnight);
      expect(() => reserveAiCall(isolated, input(), cap, beforeMidnight)).toThrow(AiBudgetError);
      expect(() => reserveAiCall(isolated, input(), cap, afterMidnight)).not.toThrow();
      expect(getBudgetUsage(isolated, { scopeType: "global", periodKey: "2026-11-25" })).toBe(1);
      expect(getBudgetUsage(isolated, { scopeType: "global", periodKey: "2026-11-26" })).toBe(1);
    } finally { isolated.close(); }
  });

  it("连接测试有独立小时频率", () => {
    const ctLimits = { ...limits, maxCallsPerDay: 100 };
    const ctInput = input({ scopeType: "connection_test", scopeId: "ct", exhibitionId: null, purpose: "connection_test" });
    reserveAiCall(db, ctInput, ctLimits, D4);
    reserveAiCall(db, ctInput, ctLimits, D4);
    expect(() => reserveAiCall(db, ctInput, ctLimits, D4)).toThrowError(/连接测试过于频繁/);
    // 下一小时恢复
    const nextHour = new Date("2026-11-23T04:00:00.000Z");
    expect(() => reserveAiCall(db, ctInput, ctLimits, nextHour)).not.toThrow();
  });
});

describe("启动回收（§7.3 重启时区分两种状态）", () => {
  it("超过宽限期的 reserved 行归还名额；新鲜的 reserved 不动", () => {
    // 回收是全局启动行为：用独立库隔离，避免前面的用例行被一并回收。
    const db2 = createDb(":memory:");
    const old = new Date("2026-11-24T00:00:00.000Z");
    const stale = reserveAiCall(db2, input({ scopeId: "wf-stale" }), limits, old);
    const fresh = reserveAiCall(db2, input({ scopeId: "wf-fresh" }), limits, D5);

    const released = releaseStaleAiReservations(db2, {
      beforeIso: new Date("2026-11-24T01:00:00.000Z").toISOString(),
    });

    expect(released).toBe(1);
    expect(getAiCall(db2, stale.id)!.status).toBe("released");
    expect(getAiCall(db2, fresh.id)!.status).toBe("reserved");
    // stale 与 fresh 共享 2026-11-24 日键：2 - 1 = 1
    expect(getBudgetUsage(db2, { scopeType: "global", scopeId: "*", periodKey: "2026-11-24" })).toBe(1);
    db2.close();
  });
});

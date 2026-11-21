import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createDb } from "@/lib/db/client";
import { createAiCall, updateAiCall, getAiCall, listAiCalls } from "@/lib/ai/records";

let db: DatabaseSync;

beforeAll(() => {
  db = createDb(":memory:");
});

afterAll(() => {
  db.close();
});

const base = {
  scopeType: "workflow" as const,
  scopeId: "wf-1",
  provider: "openai-compatible",
  model: "vision-x",
  purpose: "vision" as const,
};

describe("ai_calls 调用记录（任务书 §7.1）", () => {
  it("创建→更新→读取往返；usage 缺失记 null（未知 ≠ 0）", () => {
    const rec = createAiCall(db, { exhibitionId: "exh-1", ...base });
    expect(rec.status).toBe("reserved");
    expect(rec.usage).toBeNull();
    expect(rec.attempt).toBe(1);

    updateAiCall(db, rec.id, {
      status: "sent",
      usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
      provider_request_id: "req-abc",
      duration_ms: 1234,
    });
    const after = getAiCall(db, rec.id)!;
    expect(after.status).toBe("sent");
    expect(after.usage?.total_tokens).toBe(46);
    expect(after.provider_request_id).toBe("req-abc");
    expect(after.duration_ms).toBe(1234);
  });

  it("按作用域/用途过滤；连接测试与业务调用分开记账", () => {
    createAiCall(db, { exhibitionId: null, ...base, scopeType: "connection_test", scopeId: "ct", purpose: "connection_test" });
    const ct = listAiCalls(db, { scopeType: "connection_test", purpose: "connection_test" });
    expect(ct.length).toBe(1);
    expect(ct[0].exhibition_id).toBeNull();

    const biz = listAiCalls(db, { scopeType: "workflow", purpose: "vision" });
    expect(biz.length).toBe(1);
    expect(biz[0].exhibition_id).toBe("exh-1");
  });

  it("不存在的调用 ID 返回 null", () => {
    expect(getAiCall(db, "nope")).toBeNull();
  });
});

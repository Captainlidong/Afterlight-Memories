import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createDb } from "@/lib/db/client";
import { createExhibition, updateExhibition } from "@/lib/db/repos";
import { CreateExhibitionInput } from "@/lib/agents/schemas";
import { assertExternalSendAllowed, type AiCallContext } from "@/lib/ai/policy";
import { AiUnauthorizedError } from "@/lib/ai/errors";

let db: DatabaseSync;
let demoExh: string;
let aiExhNoAuth: string;
let aiExhAuth: string;

beforeAll(() => {
  db = createDb(":memory:");
  demoExh = createExhibition(db, CreateExhibitionInput.parse({ title: "演示影展" }), "demo").id;
  aiExhNoAuth = createExhibition(db, CreateExhibitionInput.parse({ title: "AI未授权" }), "ai").id;
  aiExhAuth = createExhibition(
    db,
    CreateExhibitionInput.parse({ title: "AI已授权", allow_external_ai: true }),
    "ai",
  ).id;
});

afterAll(() => {
  db.close();
});

function ctx(overrides: Partial<AiCallContext> = {}): AiCallContext {
  return {
    purpose: "vision",
    scopeType: "workflow",
    scopeId: "wf-1",
    exhibitionId: aiExhAuth,
    promptVersion: "vision-v1",
    schemaVersion: "visual-facts-v1",
    ...overrides,
  };
}

describe("外发授权策略（任务书 §4.3 / §8.2）", () => {
  it("mode=demo 拒绝外发（不静默回退）", () => {
    expect(() => assertExternalSendAllowed(db, ctx({ exhibitionId: demoExh }))).toThrowError(
      /未启用 AI 模式/,
    );
  });

  it("mode=ai 但未勾选外部授权 → 拒绝；提示授权内容与演示可用", () => {
    try {
      assertExternalSendAllowed(db, ctx({ exhibitionId: aiExhNoAuth }));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AiUnauthorizedError);
      const msg = (err as Error).message;
      expect(msg).toContain("模型服务");
      expect(msg).toContain("演示模式不受影响");
    }
  });

  it("mode=ai + 授权 → 放行；每次调用重读最新授权", () => {
    expect(() => assertExternalSendAllowed(db, ctx())).not.toThrow();
    // 撤销授权后立刻生效（§4.3：不能只在创建页检查一次）
    updateExhibition(db, aiExhAuth, { mode: "ai" });
    db.prepare("UPDATE exhibitions SET allow_external_ai=0 WHERE id=?").run(aiExhAuth);
    expect(() => assertExternalSendAllowed(db, ctx())).toThrowError(AiUnauthorizedError);
  });

  it("影展不存在或缺失归属 → 拒绝", () => {
    expect(() => assertExternalSendAllowed(db, ctx({ exhibitionId: "missing" }))).toThrowError(
      /不存在或已删除/,
    );
    expect(() => assertExternalSendAllowed(db, ctx({ exhibitionId: null }))).toThrowError(
      /缺少影展归属/,
    );
  });

  it("连接测试：只接受服务端构造的合法上下文，不能伪装成业务调用旁路", () => {
    const legal = {
      purpose: "connection_test" as const,
      scopeType: "connection_test" as const,
      scopeId: "ct",
      exhibitionId: null,
      promptVersion: "conn-v1",
      schemaVersion: "conn-v1",
    };
    expect(() => assertExternalSendAllowed(db, legal)).not.toThrow();

    // 带上影展归属的 connection_test → 拒绝（不能借连接测试绕业务授权）
    expect(() => assertExternalSendAllowed(db, { ...legal, exhibitionId: aiExhNoAuth })).toThrowError(
      /连接测试上下文非法/,
    );
    // 业务 purpose 但 scope 是 connection_test → 走业务路径，未授权仍拒绝
    expect(() =>
      assertExternalSendAllowed(db, { ...legal, purpose: "vision", exhibitionId: aiExhNoAuth }),
    ).toThrowError(AiUnauthorizedError);
  });
});

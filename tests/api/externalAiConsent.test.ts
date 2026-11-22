import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { DatabaseSync } from "node:sqlite";
import { createDb } from "@/lib/db/client";
import { createExhibition, getExhibition } from "@/lib/db/repos";
import { createRun } from "@/lib/db/runs";
import { CreateExhibitionInput } from "@/lib/agents/schemas";
import { PATCH } from "@/app/api/exhibitions/[id]/external-ai/route";
import { PATCH as patchExhibition } from "@/app/api/exhibitions/[id]/route";
import { updateExhibition } from "@/lib/db/repos";
import { assertExternalSendAllowed } from "@/lib/ai/policy";
import { errorResponse } from "@/lib/api/errors";
import { AiProviderAuthError, AiBudgetError } from "@/lib/ai/errors";

let db: DatabaseSync, id: string;
beforeEach(() => {
  db = createDb(":memory:");
  (globalThis as typeof globalThis & { __afterlightDb?: DatabaseSync }).__afterlightDb = db;
  id = createExhibition(db, CreateExhibitionInput.parse({ allow_external_ai: true }), "ai").id;
});
afterEach(() => {
  delete (globalThis as typeof globalThis & { __afterlightDb?: DatabaseSync }).__afterlightDb;
  db.close(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});
function consent(body: unknown, origin = "http://localhost:3000") {
  return PATCH(new Request(`http://localhost:3000/api/exhibitions/${id}/external-ai`, {
    method: "PATCH", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });
}
describe("外部处理授权", () => {
  it("生成期间仍可撤销，后续外发立即拒绝且旧作品不变", async () => {
    createRun(db, { exhibitionId: id, agentType: "material_steward", status: "running", inputVersion: 0, workflowId: "wf", inputRevision: 0 });
    const before = getExhibition(db, id)!;
    expect((await consent({ allow_external_ai: false })).status).toBe(200);
    expect(getExhibition(db, id)).toMatchObject({ ...before, allow_external_ai: false, updated_at: expect.any(String) });
    expect(() => assertExternalSendAllowed(db, { purpose: "vision", scopeType: "workflow", scopeId: "wf", exhibitionId: id, promptVersion: "v1", schemaVersion: "v1" })).toThrow();
    expect((await consent({ allow_external_ai: true })).status).toBe(409);
  });
  it("显式重新授权；跨域由 proxy 统一守卫拒绝；任意服务参数拒绝", async () => {
    // 跨域拒绝收归 proxy 统一守卫（本机模式 = assertLocalMutation；公网模式 = 访客守卫）
    const { proxy } = await import("@/proxy");
    const crossOrigin = await proxy(new NextRequest(`http://localhost:3000/api/exhibitions/${id}/external-ai`, {
      method: "PATCH", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ allow_external_ai: false }),
    }));
    expect(crossOrigin.status).toBe(403);
    expect(getExhibition(db, id)!.allow_external_ai).toBe(true);
    expect((await consent({ allow_external_ai: false, apiKey: "forbidden" })).status).toBe(400);
    expect((await consent({ allow_external_ai: false })).status).toBe(200);
    expect((await consent({ allow_external_ai: true })).status).toBe(200);
    expect(getExhibition(db, id)!.allow_external_ai).toBe(true);
  });
  it("切换模式撤销旧授权并要求重新分析，不清空现有作品", async () => {
    updateExhibition(db, id, { status: "awaiting_user_review", selection_confirmed_revision: 0 });
    const before = getExhibition(db, id)!;
    const res = await patchExhibition(new Request(`http://localhost:3000/api/exhibitions/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "demo" }),
    }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    expect(getExhibition(db, id)).toMatchObject({ mode: "demo", allow_external_ai: false, stale_from: "ingest", input_revision: before.input_revision + 1, selection_confirmed_revision: null, title: before.title, current_version: before.current_version });
  });
  it("读取慢请求正文后重新检查实际模式，不能保留并发授予的授权", async () => {
    updateExhibition(db, id, { mode: "demo", status: "awaiting_user_review" });
    let release!: (body: unknown) => void;
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const req = new Request(`http://localhost:3000/api/exhibitions/${id}`, { method: "PATCH" });
    vi.spyOn(req, "json").mockImplementation(() => {
      entered();
      return new Promise((resolve) => { release = resolve; });
    });
    const pending = patchExhibition(req, { params: Promise.resolve({ id }) });
    await reading;
    updateExhibition(db, id, { mode: "ai" });
    expect((await consent({ allow_external_ai: true })).status).toBe(200);
    updateExhibition(db, id, { selection_confirmed_revision: 0 });
    release({ mode: "demo" });
    expect((await pending).status).toBe(200);
    expect(getExhibition(db, id)).toMatchObject({ mode: "demo", allow_external_ai: false, selection_confirmed_revision: null, input_revision: 1, stale_from: "ingest" });
  });
  it("HTTP AI 错误有分类，未知错误不泄漏内容", async () => {
    const secret = "one-time-private-string";
    const auth = errorResponse(new AiProviderAuthError(secret));
    expect(auth.status).toBe(502);
    expect(await auth.text()).not.toContain(secret);
    expect(errorResponse(new AiBudgetError(secret)).status).toBe(429);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const unknown = errorResponse(new Error(secret));
    expect(await unknown.text()).not.toContain(secret);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  });
});

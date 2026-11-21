import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createDb } from "@/lib/db/client";
import { createExhibition } from "@/lib/db/repos";
import { CreateExhibitionInput } from "@/lib/agents/schemas";
import { buildCacheKey, canonicalDigest, cacheGet, cacheGetEntry, cacheSave, cacheClearScope } from "@/lib/ai/cache";
import type { CacheLookupInput } from "@/lib/ai/cache";

let db: DatabaseSync;
let exh: string;

beforeAll(() => {
  db = createDb(":memory:");
  exh = createExhibition(db, CreateExhibitionInput.parse({ title: "缓存影展" }), "ai").id;
});

afterAll(() => {
  db.close();
});

function lookup(overrides: Partial<CacheLookupInput> = {}): CacheLookupInput {
  return {
    scopeType: "workflow",
    scopeId: "wf-1",
    purpose: "vision",
    cacheKey: buildCacheKey({ photoHash: "abc", params: { edge: 1280 } }),
    provider: "openai-compatible",
    model: "vision-x",
    promptVersion: "vision-v1",
    schemaVersion: "visual-facts-v1",
    preprocessVersion: "prep-v1",
    ...overrides,
  };
}

describe("缓存键（任务书 §7.2）", () => {
  it("键只依赖输入摘要与版本：对象键序无关，值变键变", () => {
    const a = buildCacheKey({ b: 2, a: 1, nested: { x: "1", y: "2" } });
    const b = buildCacheKey({ a: 1, b: 2, nested: { y: "2", x: "1" } });
    const c = buildCacheKey({ a: 1, b: 3, nested: { x: "1", y: "2" } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("canonicalDigest 对数组保持顺序（照片集合顺序影响结果）", () => {
    expect(canonicalDigest(["a", "b"])).not.toBe(canonicalDigest(["b", "a"]));
  });
});

describe("缓存读写与失效", () => {
  it("保存后命中；不同作用域不串缓存（不同用户/影展隔离）", () => {
    const key = lookup();
    expect(cacheGet(db, key)).toBeNull();
    expect(cacheGetEntry(db, key)).toBeNull();
    cacheSave(db, { ...key, exhibitionId: exh, result: { ok: 1 }, sourceCallId: "call-1", inputDigest: "d1" });
    expect(cacheGet(db, key)).toEqual({ ok: 1 });
    expect(cacheGetEntry(db, key)).toEqual({ data: { ok: 1 }, callId: "call-1" });

    // 同一 key 但不同 scopeId → 未命中
    expect(cacheGet(db, { ...key, scopeId: "wf-2" })).toBeNull();
  });

  it("来源调用 ID 为 null 时保留 null，原 data API 不变", () => {
    const key = lookup({ scopeId: "wf-null-source" });
    cacheSave(db, { ...key, exhibitionId: exh, result: { ok: true }, sourceCallId: null, inputDigest: "d" });
    expect(cacheGetEntry(db, key)).toEqual({ data: { ok: true }, callId: null });
    expect(cacheGet(db, key)).toEqual({ ok: true });
  });

  it("缓存数据为 null 时 entry 仍保留来源且不被覆盖", () => {
    const key = lookup({ scopeId: "wf-null-data" });
    cacheSave(db, { ...key, exhibitionId: exh, result: null, sourceCallId: "call-null", inputDigest: "d" });
    expect(cacheGetEntry(db, key)).toEqual({ data: null, callId: "call-null" });
    expect(cacheGet(db, key)).toBeNull();
    expect(cacheSave(db, { ...key, exhibitionId: exh, result: {}, sourceCallId: "replacement", inputDigest: "d" })).toBe(false);
    expect(cacheGetEntry(db, key)).toEqual({ data: null, callId: "call-null" });
  });

  it("指定影展时不命中其他影展的同作用域缓存", () => {
    const key = lookup({ scopeId: "wf-exhibition" });
    cacheSave(db, { ...key, exhibitionId: exh, result: { ok: 1 }, sourceCallId: "call-exh", inputDigest: "d" });
    expect(cacheGetEntry(db, { ...key, exhibitionId: exh })).toEqual({ data: { ok: 1 }, callId: "call-exh" });
    expect(cacheGetEntry(db, { ...key, exhibitionId: "other-exhibition" })).toBeNull();
    expect(cacheGetEntry(db, { ...key, exhibitionId: null })).toBeNull();
  });

  it("版本变化（模型/提示词/schema/预处理）即失效", () => {
    const key = lookup({ scopeId: "wf-v" });
    cacheSave(db, { ...key, exhibitionId: exh, result: { ok: 1 }, sourceCallId: "c", inputDigest: "d" });
    expect(cacheGet(db, { ...key, model: "vision-y" })).toBeNull();
    expect(cacheGet(db, { ...key, promptVersion: "vision-v2" })).toBeNull();
    expect(cacheGet(db, { ...key, schemaVersion: "visual-facts-v2" })).toBeNull();
    expect(cacheGet(db, { ...key, preprocessVersion: "prep-v2" })).toBeNull();
  });

  it("同作用域同键重复保存不覆盖；cacheClearScope 清理", () => {
    const key = lookup({ scopeId: "wf-c" });
    cacheSave(db, { ...key, exhibitionId: exh, result: { v: 1 }, sourceCallId: "c1", inputDigest: "d" });
    expect(cacheSave(db, { ...key, exhibitionId: exh, result: { v: 2 }, sourceCallId: "c2", inputDigest: "d" })).toBe(false);
    expect(cacheGet(db, key)).toEqual({ v: 1 });
    expect(cacheGetEntry(db, key)).toEqual({ data: { v: 1 }, callId: "c1" });

    expect(cacheClearScope(db, "workflow", "wf-c")).toBe(1);
    expect(cacheGet(db, key)).toBeNull();
  });
});

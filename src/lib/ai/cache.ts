import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { newId, now } from "../id";
import type { AiPurpose, AiScopeType } from "./records";

/**
 * 结果缓存（任务书 v3 §7.2）：只缓存通过结构与业务校验的结果。
 * 缓存键 = 权限作用域 + 输入稳定摘要 + provider/model + 提示词/schema/预处理版本；
 * 命中仍须先通过调用者授权检查（policy 在缓存查询之前执行）。
 * 换模型、提示词、事实结构或预处理方式 → 键中版本变化，自然失效。
 * 影展删除时随外键级联清理；connection_test 不写缓存。
 */

export function canonicalDigest(input: unknown): string {
  const normalized = JSON.stringify(input, (key, value) => {
    if (value == null) return value;
    if (Array.isArray(value)) return value;
    if (typeof value === "object") {
      return Object.keys(value)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (value as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    return value;
  });
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function buildCacheKey(parts: Record<string, unknown>): string {
  return canonicalDigest(parts);
}

export interface CacheLookupInput {
  scopeType: AiScopeType;
  scopeId: string;
  /** 提供时校验影展归属；省略以兼容既有 data 查询 API。 */
  exhibitionId?: string | null;
  purpose: AiPurpose;
  cacheKey: string;
  provider: string;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  preprocessVersion: string;
}

export interface CacheSaveInput extends CacheLookupInput {
  exhibitionId: string | null;
  result: unknown;
  sourceCallId: string | null;
  inputDigest: string;
}

interface CacheRow {
  result_json: string;
  source_call_id: string | null;
  exhibition_id: string | null;
}

export interface CacheEntry {
  data: unknown;
  callId: string | null;
}

/** 保留原 data API；需要来源调用 ID 时使用 cacheGetEntry。 */
export function cacheGet(db: DatabaseSync, input: CacheLookupInput): unknown | null {
  return cacheGetEntry(db, input)?.data ?? null;
}

/** 命中且版本一致时返回缓存结果及原调用 ID；版本不一致视为未命中。 */
export function cacheGetEntry(db: DatabaseSync, input: CacheLookupInput): CacheEntry | null {
  const r = db
    .prepare(
      `SELECT result_json, source_call_id, exhibition_id FROM ai_cache
       WHERE scope_type=? AND scope_id=? AND purpose=? AND cache_key=?
         AND provider=? AND model=? AND prompt_version=? AND schema_version=? AND preprocess_version=?`,
    )
    .get(
      input.scopeType,
      input.scopeId,
      input.purpose,
      input.cacheKey,
      input.provider,
      input.model,
      input.promptVersion,
      input.schemaVersion,
      input.preprocessVersion,
    ) as CacheRow | undefined;
  if (!r || (input.exhibitionId !== undefined && r.exhibition_id !== input.exhibitionId)) return null;
  try {
    return { data: JSON.parse(r.result_json), callId: r.source_call_id };
  } catch {
    cacheDeleteEntry(db, input);
    return null;
  }
}

/** 只删除精确命中的损坏项，不能清空整个影展或其他版本。 */
export function cacheDeleteEntry(db: DatabaseSync, input: CacheLookupInput): void {
  db.prepare(`DELETE FROM ai_cache
    WHERE scope_type=? AND scope_id=? AND purpose=? AND cache_key=?
      AND provider=? AND model=? AND prompt_version=? AND schema_version=? AND preprocess_version=?
      AND (?=0 OR exhibition_id IS ?)`)
    .run(input.scopeType, input.scopeId, input.purpose, input.cacheKey, input.provider, input.model,
      input.promptVersion, input.schemaVersion, input.preprocessVersion,
      input.exhibitionId === undefined ? 0 : 1, input.exhibitionId ?? null);
}

/** 仅保存已校验的结果；同作用域同键已存在时保持原记录（原子占位，不覆盖）。 */
export function cacheSave(db: DatabaseSync, input: CacheSaveInput): boolean {
  const existing = cacheGetEntry(db, input);
  if (existing !== null) return false;
  try {
    db.prepare(
      `INSERT OR IGNORE INTO ai_cache
        (id, scope_type, scope_id, exhibition_id, purpose, cache_key, provider, model,
         prompt_version, schema_version, preprocess_version, result_json, source_call_id,
         input_digest, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      newId("aicache"),
      input.scopeType,
      input.scopeId,
      input.exhibitionId ?? null,
      input.purpose,
      input.cacheKey,
      input.provider,
      input.model,
      input.promptVersion,
      input.schemaVersion,
      input.preprocessVersion,
      JSON.stringify(input.result),
      input.sourceCallId ?? null,
      input.inputDigest,
      now(),
    );
    return true;
  } catch {
    return false;
  }
}

/** 删除指定作用域的缓存（影展删除之外的显式清理入口；级联已覆盖影展删除场景）。 */
export function cacheClearScope(db: DatabaseSync, scopeType: AiScopeType, scopeId: string): number {
  const r = db
    .prepare("DELETE FROM ai_cache WHERE scope_type=? AND scope_id=?")
    .run(scopeType, scopeId);
  return Number(r.changes);
}

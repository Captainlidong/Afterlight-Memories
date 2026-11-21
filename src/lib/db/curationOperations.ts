import type { DatabaseSync } from "node:sqlite";
import { newId, now } from "../id";
import { getDecision } from "./curation";

/**
 * 策展操作历史（任务书 v2.1 §19.5 / §19.11）。
 * 一次批量/确认 = 一条操作记录：before/after 快照支持撤销，request_id 支持幂等重试。
 */
export type CurationOperationAction = "set_decision" | "restore_ai_suggestion" | "confirm_selection";

export interface CurationOperation {
  id: string;
  exhibition_id: string;
  action: CurationOperationAction;
  decision: string | null;
  photo_ids: string[];
  before_json: unknown;
  after_json: unknown;
  revision: number;
  request_id: string | null;
  undone: boolean;
  created_at: string;
}

interface OperationRow {
  id: string;
  exhibition_id: string;
  action: string;
  decision: string | null;
  photo_ids: string;
  before_json: string;
  after_json: string;
  revision: number;
  request_id: string | null;
  undone: number;
  created_at: string;
}

function mapRow(r: OperationRow): CurationOperation {
  return {
    id: r.id,
    exhibition_id: r.exhibition_id,
    action: r.action as CurationOperationAction,
    decision: r.decision,
    photo_ids: JSON.parse(r.photo_ids),
    before_json: JSON.parse(r.before_json),
    after_json: JSON.parse(r.after_json),
    revision: r.revision,
    request_id: r.request_id,
    undone: r.undone === 1,
    created_at: r.created_at,
  };
}

export function insertOperation(
  db: DatabaseSync,
  op: {
    exhibitionId: string;
    action: CurationOperationAction;
    decision?: string | null;
    photoIds: string[];
    before: unknown;
    after: unknown;
    revision: number;
    requestId?: string | null;
  },
): CurationOperation {
  const id = newId("op");
  db.prepare(
    `INSERT INTO curation_operations
      (id, exhibition_id, action, decision, photo_ids, before_json, after_json, revision, request_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    op.exhibitionId,
    op.action,
    op.decision ?? null,
    JSON.stringify(op.photoIds),
    JSON.stringify(op.before),
    JSON.stringify(op.after),
    op.revision,
    op.requestId ?? null,
    now(),
  );
  return getOperation(db, id)!;
}

export function getOperation(db: DatabaseSync, operationId: string): CurationOperation | null {
  const r = db.prepare("SELECT * FROM curation_operations WHERE id=?").get(operationId) as
    | OperationRow
    | undefined;
  return r ? mapRow(r) : null;
}

export function findOperationByRequest(
  db: DatabaseSync,
  exhibitionId: string,
  requestId: string,
): CurationOperation | null {
  const r = db
    .prepare("SELECT * FROM curation_operations WHERE exhibition_id=? AND request_id=?")
    .get(exhibitionId, requestId) as OperationRow | undefined;
  return r ? mapRow(r) : null;
}

export function listOperations(db: DatabaseSync, exhibitionId: string): CurationOperation[] {
  const rows = db
    .prepare("SELECT * FROM curation_operations WHERE exhibition_id=? ORDER BY created_at DESC")
    .all(exhibitionId) as unknown as OperationRow[];
  return rows.map(mapRow);
}

export function markOperationUndone(db: DatabaseSync, operationId: string): void {
  db.prepare("UPDATE curation_operations SET undone=1 WHERE id=?").run(operationId);
}

/** 批量操作快照：仅记录实际改变照片的覆盖与原因（before/after 同构）。 */
export interface OverrideSnapshot {
  photo_id: string;
  user_override: string | null;
  override_reason: string | null;
}

export interface BatchAfterSnapshot {
  overrides: OverrideSnapshot[];
  skipped_ids: string[];
  skipped_reason: string | null;
}

/** 最新一条操作（按插入序，避免同毫秒 created_at 并列）。 */
export function latestOperation(db: DatabaseSync, exhibitionId: string): CurationOperation | null {
  const r = db
    .prepare("SELECT * FROM curation_operations WHERE exhibition_id=? ORDER BY rowid DESC LIMIT 1")
    .get(exhibitionId) as OperationRow | undefined;
  return r ? mapRow(r) : null;
}

export function hasLaterOperation(db: DatabaseSync, exhibitionId: string, operationId: string): boolean {
  const r = db
    .prepare(
      `SELECT 1 FROM curation_operations
       WHERE exhibition_id=? AND rowid > (SELECT rowid FROM curation_operations WHERE id=?)
       LIMIT 1`,
    )
    .get(exhibitionId, operationId);
  return r != null;
}

/** 操作改变的照片当前覆盖是否仍与 after 快照一致（单张编辑不写操作历史，需靠快照兜底）。 */
export function snapshotMatches(db: DatabaseSync, op: CurationOperation): boolean {
  const after = op.after_json as BatchAfterSnapshot;
  for (const s of after.overrides) {
    const d = getDecision(db, s.photo_id);
    if (!d || d.user_override !== s.user_override || d.override_reason !== s.override_reason) {
      return false;
    }
  }
  return true;
}

export interface UndoableOperationSummary {
  id: string;
  action: CurationOperationAction;
  decision: string | null;
  photo_ids: string[];
  revision: number;
  created_at: string;
}

/** 可撤销入口：最新、未撤销、非确认、且快照仍一致。否则 null（前端不显示撤销）。 */
export function latestUndoableOperation(db: DatabaseSync, exhibitionId: string): UndoableOperationSummary | null {
  const op = latestOperation(db, exhibitionId);
  if (!op || op.undone || op.action === "confirm_selection") return null;
  if (!snapshotMatches(db, op)) return null;
  return {
    id: op.id,
    action: op.action,
    decision: op.decision,
    photo_ids: op.photo_ids,
    revision: op.revision,
    created_at: op.created_at,
  };
}
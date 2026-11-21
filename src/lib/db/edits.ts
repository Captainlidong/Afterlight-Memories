import type { DatabaseSync } from "node:sqlite";
import type { UserEditDTO } from "@/types";
import { newId, now } from "../id";

/**
 * 用户编辑覆盖层（§5.2 / 提示词8）。稳定 target_path 语法：
 *   narrative.title|subtitle|curatorial_statement|chapter_order
 *   chapter:<id>.title|description|photo_order|locked
 *   photo:<id>.membership|placement
 * UNIQUE(exhibition_id, target_path)：同路径只一行，重编辑覆盖 value/locked 但保留 created_at（回放序稳定）。
 * merge.ts 按 created_at,rowid 回放；锁定行同样回放，系统永不丢弃。
 */
function mapRow(r: Record<string, unknown>): UserEditDTO {
  return {
    id: r.id as string,
    exhibition_id: r.exhibition_id as string,
    target_path: r.target_path as string,
    value: JSON.parse(r.value_json as string),
    locked: !!r.locked,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

export function upsertEdit(
  db: DatabaseSync,
  exhibitionId: string,
  targetPath: string,
  value: unknown,
  locked = false,
): UserEditDTO {
  const ts = now();
  db.prepare(
    `INSERT INTO user_edits (id, exhibition_id, target_path, value_json, locked, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(exhibition_id, target_path) DO UPDATE SET
       value_json=excluded.value_json, locked=excluded.locked, updated_at=excluded.updated_at`,
  ).run(newId("edit"), exhibitionId, targetPath, JSON.stringify(value), locked ? 1 : 0, ts, ts);
  return getEdit(db, exhibitionId, targetPath)!;
}

export function getEdit(db: DatabaseSync, exhibitionId: string, targetPath: string): UserEditDTO | null {
  const r = db
    .prepare("SELECT * FROM user_edits WHERE exhibition_id = ? AND target_path = ?")
    .get(exhibitionId, targetPath) as Record<string, unknown> | undefined;
  return r ? mapRow(r) : null;
}

export function listEdits(db: DatabaseSync, exhibitionId: string): UserEditDTO[] {
  const rows = db
    .prepare("SELECT * FROM user_edits WHERE exhibition_id = ? ORDER BY created_at, rowid")
    .all(exhibitionId) as unknown as Record<string, unknown>[];
  return rows.map(mapRow);
}

export function deleteEdit(db: DatabaseSync, exhibitionId: string, targetPath: string): void {
  db.prepare("DELETE FROM user_edits WHERE exhibition_id = ? AND target_path = ?").run(exhibitionId, targetPath);
}

export function deleteEdits(db: DatabaseSync, exhibitionId: string): void {
  db.prepare("DELETE FROM user_edits WHERE exhibition_id = ?").run(exhibitionId);
}
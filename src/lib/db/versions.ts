import type { DatabaseSync } from "node:sqlite";
import type { VersionDTO, VersionSummary } from "@/types";
import { newId, now } from "../id";

/**
 * 版本快照（§10.11 / 提示词8）。snapshot_json 含 narrative+motifs+decisions+user_edits+template+selected_motif_id+tone+layout。
 * 每次完整管线成功 + 破坏性操作前写一版；保留最近 10 个；回滚单事务恢复（含编辑/锁定）。
 */
export function insertVersion(
  db: DatabaseSync,
  exhibitionId: string,
  version: number,
  snapshot: unknown,
  label?: string | null,
): VersionDTO {
  db.prepare(
    `INSERT INTO exhibition_versions (id, exhibition_id, version, label, snapshot_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(newId("ver"), exhibitionId, version, label ?? null, JSON.stringify(snapshot), now());
  return getVersion(db, exhibitionId, version)!;
}

export function listVersions(db: DatabaseSync, exhibitionId: string): VersionSummary[] {
  const rows = db
    .prepare(
      "SELECT id, exhibition_id, version, label, created_at FROM exhibition_versions WHERE exhibition_id = ? ORDER BY version DESC",
    )
    .all(exhibitionId) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    exhibition_id: r.exhibition_id as string,
    version: r.version as number,
    label: (r.label as string | null) ?? null,
    created_at: r.created_at as string,
  }));
}

export function getVersion(db: DatabaseSync, exhibitionId: string, version: number): VersionDTO | null {
  const r = db
    .prepare("SELECT * FROM exhibition_versions WHERE exhibition_id = ? AND version = ?")
    .get(exhibitionId, version) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    id: r.id as string,
    exhibition_id: r.exhibition_id as string,
    version: r.version as number,
    label: (r.label as string | null) ?? null,
    created_at: r.created_at as string,
    snapshot: JSON.parse(r.snapshot_json as string),
  };
}

/** 仅保留最近 keep 个版本（按 version 倒序），删除更旧的。 */
export function pruneVersions(db: DatabaseSync, exhibitionId: string, keep = 10): void {
  db.prepare(
    `DELETE FROM exhibition_versions
     WHERE exhibition_id = ?
       AND version NOT IN (
         SELECT version FROM exhibition_versions WHERE exhibition_id = ? ORDER BY version DESC LIMIT ?
       )`,
  ).run(exhibitionId, exhibitionId, keep);
}
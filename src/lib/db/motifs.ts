import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { newId, now } from "../id";
import { getExhibition, updateExhibition } from "./repos";
import type { MotifT } from "../agents/schemas";
import type { MotifDTO } from "@/types";

/**
 * 主题持久化（设计文档 §6.4 / §10.5 / §11.7）。
 * 每影展多条候选主题；user_title 为用户改名（effective_title = user_title ?? title）。
 * 重跑 replaceMotifs 会按标题延续改名；已选主题仍在候选中则延续选择，否则重置回主题门。
 */
interface MotifRow {
  id: string;
  exhibition_id: string;
  title: string;
  user_title: string | null;
  description: string;
  photo_ids: string;
  evidence: string;
  confidence: number;
  alternative_readings: string;
  state: string;
  run_id: string | null;
  created_at: string;
}

function mapRow(r: MotifRow): MotifDTO {
  return {
    id: r.id,
    exhibition_id: r.exhibition_id,
    title: r.title,
    user_title: r.user_title,
    effective_title: r.user_title ?? r.title,
    description: r.description,
    photo_ids: JSON.parse(r.photo_ids),
    evidence: JSON.parse(r.evidence),
    confidence: r.confidence,
    alternative_readings: JSON.parse(r.alternative_readings),
    state: r.state as MotifDTO["state"],
    run_id: r.run_id,
    created_at: r.created_at,
  };
}

/** 替换整组候选主题（单事务）。按标题延续用户改名；已选主题若仍在候选中按标题延续选择，否则重置回主题门。 */
export function replaceMotifs(
  db: DatabaseSync,
  exhibitionId: string,
  motifs: MotifT[],
  runId?: string | null,
): void {
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    const prior = db
      .prepare("SELECT title, user_title, state FROM motifs WHERE exhibition_id=?")
      .all(exhibitionId) as unknown as { title: string; user_title: string | null; state: string }[];
    const renameByTitle = new Map(prior.map((p) => [p.title, p.user_title]));
    const rejectedTitles = new Set(prior.filter((p) => p.state === "rejected").map((p) => p.title));
    const selectedId = getExhibition(db, exhibitionId)?.selected_motif_id ?? null;
    const selectedTitle = selectedId
      ? ((db.prepare("SELECT title FROM motifs WHERE id=?").get(selectedId) as { title: string } | undefined)?.title ?? null)
      : null;
    db.prepare("DELETE FROM motifs WHERE exhibition_id=?").run(exhibitionId);
    const stmt = db.prepare(
      `INSERT INTO motifs
        (id, exhibition_id, title, user_title, description, photo_ids, evidence,
         confidence, alternative_readings, state, run_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const m of motifs) {
      stmt.run(
        m.id ?? newId("motif"),
        exhibitionId,
        m.title,
        renameByTitle.get(m.title) ?? null,
        m.description,
        JSON.stringify(m.photo_ids),
        JSON.stringify(m.evidence),
        m.confidence,
        JSON.stringify(m.alternative_readings),
        rejectedTitles.has(m.title) ? "rejected" : "proposed",
        runId ?? null,
        now(),
      );
    }
    const carried = selectedTitle
      ? (db
          .prepare("SELECT id FROM motifs WHERE exhibition_id=? AND title=?")
          .get(exhibitionId, selectedTitle) as { id: string } | undefined)
      : undefined;
    if (carried) {
      db.prepare("UPDATE motifs SET state='selected' WHERE id=?").run(carried.id);
      updateExhibition(db, exhibitionId, { selected_motif_id: carried.id });
    } else {
      updateExhibition(db, exhibitionId, { selected_motif_id: null });
    }
    if (ownsTransaction) db.exec("COMMIT");
  } catch (err) {
    if (ownsTransaction && db.isTransaction) db.exec("ROLLBACK");
    throw err;
  }
}

export function getMotif(db: DatabaseSync, motifId: string): MotifDTO | null {
  const r = db.prepare("SELECT * FROM motifs WHERE id=?").get(motifId) as MotifRow | undefined;
  return r ? mapRow(r) : null;
}

export function listMotifs(db: DatabaseSync, exhibitionId: string): MotifDTO[] {
  const rows = db
    .prepare("SELECT * FROM motifs WHERE exhibition_id=? ORDER BY rowid")
    .all(exhibitionId) as unknown as MotifRow[];
  return rows.map(mapRow);
}

/** 选择主线：目标置 selected，其余已选回 proposed；写 exhibitions.selected_motif_id。 */
export function selectMotif(
  db: DatabaseSync,
  exhibitionId: string,
  motifId: string,
  customTitle?: string | null,
): void {
  db.exec("BEGIN");
  try {
    db.prepare(
      "UPDATE motifs SET state='proposed' WHERE exhibition_id=? AND state='selected'",
    ).run(exhibitionId);
    if (customTitle != null) {
      db.prepare("UPDATE motifs SET state='selected', user_title=? WHERE id=? AND exhibition_id=?")
        .run(customTitle, motifId, exhibitionId);
    } else {
      db.prepare("UPDATE motifs SET state='selected' WHERE id=? AND exhibition_id=?")
        .run(motifId, exhibitionId);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  updateExhibition(db, exhibitionId, { selected_motif_id: motifId });
}

/** 改名 / 拒绝。拒绝已选主题时清空 selected_motif_id。 */
export function updateMotif(
  db: DatabaseSync,
  exhibitionId: string,
  motifId: string,
  fields: { user_title?: string | null; state?: "proposed" | "rejected" },
): void {
  const sets: string[] = [];
  const values: SQLInputValue[] = [];
  if (fields.user_title !== undefined) {
    sets.push("user_title=?");
    values.push(fields.user_title);
  }
  if (fields.state !== undefined) {
    sets.push("state=?");
    values.push(fields.state);
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE motifs SET ${sets.join(", ")} WHERE id=? AND exhibition_id=?`).run(
    ...values,
    motifId,
    exhibitionId,
  );
  if (fields.state === "rejected" && getExhibition(db, exhibitionId)?.selected_motif_id === motifId) {
    updateExhibition(db, exhibitionId, { selected_motif_id: null });
  }
}
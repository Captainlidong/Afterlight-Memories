import type { DatabaseSync } from "node:sqlite";
import type { NarrativePlanT } from "../agents/schemas";
import type { NarrativeDTO } from "@/types";
import { now } from "../id";

/**
 * 叙事计划持久化（§10.6）。每影展一条当前行，完整历史在 agent_runs.output_json + 版本快照。
 * replaceNarrative 是 AI 重跑的落库点：整行覆盖（用户编辑由 merge.ts 在落库前回放，不在此处）。
 */
export function replaceNarrative(
  db: DatabaseSync,
  exhibitionId: string,
  plan: NarrativePlanT,
  opts: { source: string; inputVersion: number; runId?: string | null; selectedMotifId?: string | null },
): void {
  // 复用调用方的发布事务；独立调用也必须保证高水位与当前行一起成功/回滚。
  const ownTransaction = !db.isTransaction;
  if (ownTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    const revision = db.prepare(
      `UPDATE exhibitions SET narrative_edit_revision = MAX(narrative_edit_revision,
         COALESCE((SELECT edit_revision FROM narrative_plans WHERE exhibition_id=?), 0)) + 1
       WHERE id=? RETURNING narrative_edit_revision`,
    ).get(exhibitionId, exhibitionId) as { narrative_edit_revision: number };
    db.prepare(
      `INSERT INTO narrative_plans
         (exhibition_id, selected_motif_id, title, subtitle, curatorial_statement, chapters, tone, source, input_version, run_id, updated_at, edit_revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(exhibition_id) DO UPDATE SET
         selected_motif_id=excluded.selected_motif_id, title=excluded.title, subtitle=excluded.subtitle,
         curatorial_statement=excluded.curatorial_statement, chapters=excluded.chapters, tone=excluded.tone,
         source=excluded.source, input_version=excluded.input_version, run_id=excluded.run_id,
         updated_at=excluded.updated_at, edit_revision=excluded.edit_revision`,
    ).run(
      exhibitionId,
      opts.selectedMotifId ?? plan.selected_motif_id ?? null,
      plan.title, plan.subtitle, plan.curatorial_statement, JSON.stringify(plan.chapters), plan.tone,
      opts.source, opts.inputVersion, opts.runId ?? null, now(), revision.narrative_edit_revision,
    );
    if (ownTransaction) db.exec("COMMIT");
  } catch (err) {
    if (ownTransaction) db.exec("ROLLBACK");
    throw err;
  }
}

export function getNarrative(db: DatabaseSync, exhibitionId: string): NarrativeDTO | null {
  const r = db
    .prepare(`SELECT n.*, e.current_version FROM narrative_plans n
      JOIN exhibitions e ON e.id=n.exhibition_id WHERE n.exhibition_id = ?`)
    .get(exhibitionId) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    current_version: r.current_version as number,
    edit_revision: r.edit_revision as number,
    exhibition_id: r.exhibition_id as string,
    selected_motif_id: (r.selected_motif_id as string | null) ?? null,
    title: r.title as string,
    subtitle: (r.subtitle as string) ?? "",
    curatorial_statement: r.curatorial_statement as string,
    chapters: JSON.parse(r.chapters as string),
    tone: r.tone as NarrativeDTO["tone"],
    source: r.source as string,
    input_version: r.input_version as number,
    run_id: (r.run_id as string | null) ?? null,
    updated_at: r.updated_at as string,
  };
}
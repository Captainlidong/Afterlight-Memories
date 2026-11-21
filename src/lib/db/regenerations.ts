import type { DatabaseSync } from "node:sqlite";
import { now } from "../id";

/**
 * 叙事重跑意图（v3 R01）。与 pipeline 预留同一事务写入；叙事成功发布时应用。
 * 失败/被门禁拒绝时该行随事务回滚或保持 pending，旧编辑与语气不受影响。
 */
export type RegenerationScope = "preserve" | "unlocked" | "all";

export interface RegenerationIntent {
  run_id: string;
  exhibition_id: string;
  workflow_id: string;
  scope: RegenerationScope;
  tone: string | null;
  expected_input_revision: number;
  state: "pending" | "applied" | "superseded";
  created_at: string;
  applied_at: string | null;
}

export function insertRegenerationIntent(
  db: DatabaseSync,
  intent: {
    runId: string;
    exhibitionId: string;
    workflowId: string;
    scope: RegenerationScope;
    tone: string | null;
    expectedInputRevision: number;
  },
): void {
  db.prepare(
    `INSERT INTO narrative_regenerations
       (run_id, exhibition_id, workflow_id, scope, tone, expected_input_revision, state, created_at)
     VALUES (?,?,?,?,?,?, 'pending', ?)`,
  ).run(
    intent.runId,
    intent.exhibitionId,
    intent.workflowId,
    intent.scope,
    intent.tone,
    intent.expectedInputRevision,
    now(),
  );
}

export function getRegenerationIntent(db: DatabaseSync, runId: string): RegenerationIntent | null {
  const r = db
    .prepare("SELECT * FROM narrative_regenerations WHERE run_id=?")
    .get(runId) as RegenerationIntent | undefined;
  return r ?? null;
}

export function markRegenerationApplied(db: DatabaseSync, runId: string): void {
  db.prepare(
    "UPDATE narrative_regenerations SET state='applied', applied_at=? WHERE run_id=? AND state='pending'",
  ).run(now(), runId);
}

export function markRegenerationSuperseded(db: DatabaseSync, runId: string): void {
  db.prepare(
    "UPDATE narrative_regenerations SET state='superseded', applied_at=? WHERE run_id=? AND state='pending'",
  ).run(now(), runId);
}

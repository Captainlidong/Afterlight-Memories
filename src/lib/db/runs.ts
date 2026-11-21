import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { newId, now } from "../id";
import type { AgentTypeT, RunStatusT } from "../agents/schemas";
import type { AgentRun } from "@/types";

interface RunRow {
  id: string;
  exhibition_id: string;
  agent_type: string;
  status: string;
  input_version: number;
  workflow_id: string | null;
  input_revision: number | null;
  input_json: string | null;
  output_json: string | null;
  error_message: string | null;
  duration_ms: number | null;
  created_at: string;
  finished_at: string | null;
}

function mapRun(r: RunRow): AgentRun {
  return {
    id: r.id,
    exhibition_id: r.exhibition_id,
    agent_type: r.agent_type as AgentTypeT,
    status: r.status as RunStatusT,
    input_version: r.input_version,
    workflow_id: r.workflow_id,
    input_revision: r.input_revision,
    input_json: r.input_json ? JSON.parse(r.input_json) : null,
    output_json: r.output_json ? JSON.parse(r.output_json) : null,
    error_message: r.error_message,
    duration_ms: r.duration_ms,
    created_at: r.created_at,
    finished_at: r.finished_at,
  };
}

export function createRun(
  db: DatabaseSync,
  opts: {
    exhibitionId: string;
    agentType: AgentTypeT;
    status?: RunStatusT;
    inputVersion: number;
    input?: unknown;
    workflowId?: string | null;
    inputRevision?: number | null;
  },
): AgentRun {
  const id = newId("run");
  db.prepare(
    `INSERT INTO agent_runs
      (id, exhibition_id, agent_type, status, input_version, input_json, workflow_id, input_revision, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    opts.exhibitionId,
    opts.agentType,
    opts.status ?? "pending",
    opts.inputVersion,
    opts.input === undefined ? null : JSON.stringify(opts.input),
    opts.workflowId ?? null,
    opts.inputRevision ?? null,
    now(),
  );
  return getRun(db, id)!;
}

export function updateRun(
  db: DatabaseSync,
  runId: string,
  fields: {
    status?: RunStatusT;
    output?: unknown;
    error_message?: string | null;
    duration_ms?: number | null;
    finished_at?: string | null;
  },
): void {
  const sets: string[] = [];
  const values: SQLInputValue[] = [];
  if (fields.status !== undefined) {
    sets.push("status=?");
    values.push(fields.status);
  }
  if (fields.output !== undefined) {
    sets.push("output_json=?");
    values.push(JSON.stringify(fields.output));
  }
  if (fields.error_message !== undefined) {
    sets.push("error_message=?");
    values.push(fields.error_message);
  }
  if (fields.duration_ms !== undefined) {
    sets.push("duration_ms=?");
    values.push(fields.duration_ms);
  }
  if (fields.finished_at !== undefined) {
    sets.push("finished_at=?");
    values.push(fields.finished_at);
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE agent_runs SET ${sets.join(", ")} WHERE id=?`).run(...values, runId);
}

export function getRun(db: DatabaseSync, runId: string): AgentRun | null {
  const r = db.prepare("SELECT * FROM agent_runs WHERE id=?").get(runId) as RunRow | undefined;
  return r ? mapRun(r) : null;
}

export function listRuns(db: DatabaseSync, exhibitionId: string): AgentRun[] {
  const rows = db
    .prepare("SELECT * FROM agent_runs WHERE exhibition_id=? ORDER BY created_at, rowid")
    .all(exhibitionId) as unknown as RunRow[];
  return rows.map(mapRun);
}

/** 是否存在正在运行的任务（DB 守卫，热重载后仍有效）。 */
export function hasRunningRun(db: DatabaseSync, exhibitionId: string): boolean {
  const r = db
    .prepare("SELECT 1 AS x FROM agent_runs WHERE exhibition_id=? AND status='running' LIMIT 1")
    .get(exhibitionId) as { x: number } | undefined;
  return r != null;
}
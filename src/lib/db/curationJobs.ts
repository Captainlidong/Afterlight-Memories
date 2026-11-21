import type { DatabaseSync } from "node:sqlite";
import { newId, now } from "../id";
import { listPhotos } from "./photos";
import type { Exhibition } from "@/types";

export interface CurationJob {
  id: string;
  exhibition_id: string;
  max_calls: number;
  created_at: string;
}

export interface CurationWorkflow {
  workflow_id: string;
  curation_job_id: string;
  exhibition_id: string;
  input_revision: number;
  photo_ids: string[];
}

export function getCurationJob(db: DatabaseSync, exhibitionId: string): CurationJob | null {
  const row = db.prepare("SELECT * FROM curation_jobs WHERE exhibition_id=?").get(exhibitionId) as CurationJob | undefined;
  return row ?? null;
}

export function ensureCurationJob(db: DatabaseSync, exhibitionId: string, maxCalls: number): CurationJob {
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    let job = getCurationJob(db, exhibitionId);
    if (!job) {
      job = { id: newId("job"), exhibition_id: exhibitionId, max_calls: maxCalls, created_at: now() };
      db.prepare("INSERT INTO curation_jobs (id, exhibition_id, max_calls, created_at) VALUES (?,?,?,?)")
        .run(job.id, job.exhibition_id, job.max_calls, job.created_at);
      // 升级前已有外发也计入总额；旧预留无法精确归属时保守占额，不改原审计记录。
      const prior = db.prepare("SELECT COUNT(*) AS used FROM ai_calls WHERE exhibition_id=? AND purpose!='connection_test' AND status!='released'")
        .get(exhibitionId) as { used: number };
      db.prepare("INSERT INTO ai_budget_counters (scope_type, scope_id, period_key, used) VALUES ('job',?,'total',?)")
        .run(job.id, prior.used);
    }
    if (ownsTransaction) db.exec("COMMIT");
    return job;
  } catch (error) {
    if (ownsTransaction && db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function bindCurationWorkflow(db: DatabaseSync, exhibition: Exhibition, workflowId: string, maxCalls: number): CurationWorkflow {
  const job = ensureCurationJob(db, exhibition.id, maxCalls);
  const photoIds = listPhotos(db, exhibition.id).map(p => p.id);
  db.prepare("INSERT INTO curation_job_workflows (workflow_id, curation_job_id, input_revision, photo_ids_json, created_at) VALUES (?,?,?,?,?)")
    .run(workflowId, job.id, exhibition.input_revision, JSON.stringify(photoIds), now());
  return { workflow_id: workflowId, curation_job_id: job.id, exhibition_id: exhibition.id, input_revision: exhibition.input_revision, photo_ids: photoIds };
}

export function getCurationWorkflow(db: DatabaseSync, workflowId: string): CurationWorkflow | null {
  const row = db.prepare(`SELECT w.workflow_id, w.curation_job_id, j.exhibition_id, w.input_revision, w.photo_ids_json
    FROM curation_job_workflows w JOIN curation_jobs j ON j.id=w.curation_job_id WHERE w.workflow_id=?`)
    .get(workflowId) as { workflow_id: string; curation_job_id: string; exhibition_id: string; input_revision: number; photo_ids_json: string } | undefined;
  if (!row) return null;
  return { workflow_id: row.workflow_id, curation_job_id: row.curation_job_id, exhibition_id: row.exhibition_id, input_revision: row.input_revision, photo_ids: JSON.parse(row.photo_ids_json) };
}

import type { DatabaseSync } from "node:sqlite";
import { now } from "../id";

/**
 * run 触发幂等键（任务书 v2.1 §19.2.9）。
 * 一次显式触发 = 一个 request_id → workflow；网络重试复用原键返回同一 workflow。
 */
export interface WorkflowRequest {
  exhibition_id: string;
  request_id: string;
  workflow_id: string;
  run_id: string;
  created_at: string;
}

export function getWorkflowRequest(
  db: DatabaseSync,
  exhibitionId: string,
  requestId: string,
): WorkflowRequest | null {
  const r = db
    .prepare("SELECT * FROM workflow_requests WHERE exhibition_id=? AND request_id=?")
    .get(exhibitionId, requestId) as WorkflowRequest | undefined;
  return r ?? null;
}

export function insertWorkflowRequest(
  db: DatabaseSync,
  req: { exhibitionId: string; requestId: string; workflowId: string; runId: string },
): void {
  db.prepare(
    `INSERT INTO workflow_requests (exhibition_id, request_id, workflow_id, run_id, created_at)
     VALUES (?,?,?,?,?)`,
  ).run(req.exhibitionId, req.requestId, req.workflowId, req.runId, now());
}
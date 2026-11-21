import type { DatabaseSync } from "node:sqlite";
import { now } from "../id";
import type {
  AiDecisionT,
  CurationDecisionT,
  UserDecisionT,
} from "../agents/schemas";
import type { CurationDecisionDTO } from "@/types";

/**
 * 审美筛选决定持久化（设计文档 §5.2 / §10.4 / 提示词3）。
 * 核心保证：ai_decision 与 user_override 列分离。
 * - upsertAiDecision 只写 ai_* 列，ON CONFLICT 绝不触碰 user_override/override_reason；
 * - must_keep 只能经 setUserOverride 写入，结构上不可能由 Agent 产出。
 * 读取一律 effective_decision = user_override ?? ai_decision。
 */
interface CurationRow {
  photo_id: string;
  exhibition_id: string;
  ai_decision: string;
  score: number;
  confidence: number;
  reasons: string;
  related_photo_ids: string;
  user_override: string | null;
  override_reason: string | null;
  run_id: string | null;
  updated_at: string;
}

function mapRow(r: CurationRow): CurationDecisionDTO {
  const ai = r.ai_decision as AiDecisionT;
  const override = r.user_override as UserDecisionT | null;
  return {
    photo_id: r.photo_id,
    exhibition_id: r.exhibition_id,
    ai_decision: ai,
    score: r.score,
    confidence: r.confidence,
    reasons: JSON.parse(r.reasons),
    related_photo_ids: JSON.parse(r.related_photo_ids),
    user_override: override,
    override_reason: r.override_reason,
    effective_decision: override ?? ai,
    run_id: r.run_id,
    updated_at: r.updated_at,
  };
}

/** 写入/更新 AI 决定。保留任何已存在的用户覆盖（must_keep 保护）。 */
export function upsertAiDecision(
  db: DatabaseSync,
  exhibitionId: string,
  d: CurationDecisionT,
  runId?: string | null,
): void {
  db.prepare(
    `INSERT INTO curation_decisions
      (photo_id, exhibition_id, ai_decision, score, confidence, reasons,
       related_photo_ids, run_id, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(photo_id) DO UPDATE SET
       ai_decision=excluded.ai_decision, score=excluded.score, confidence=excluded.confidence,
       reasons=excluded.reasons, related_photo_ids=excluded.related_photo_ids,
       run_id=excluded.run_id, updated_at=excluded.updated_at`,
  ).run(
    d.photo_id,
    exhibitionId,
    d.decision,
    d.score,
    d.confidence,
    JSON.stringify(d.reasons),
    JSON.stringify(d.related_photo_ids),
    runId ?? null,
    now(),
  );
}

/** 用户覆盖决定（keep/hold/remove/must_keep 的唯一入口）。仅更新已有 AI 决定行。 */
export function setUserOverride(
  db: DatabaseSync,
  exhibitionId: string,
  photoId: string,
  decision: UserDecisionT,
  reason?: string | null,
): void {
  db.prepare(
    `UPDATE curation_decisions
     SET user_override=?, override_reason=?, updated_at=?
     WHERE photo_id=? AND exhibition_id=?`,
  ).run(decision, reason ?? null, now(), photoId, exhibitionId);
}

/** 恢复 AI 建议：把用户覆盖置 null（不是把 AI 决定复制成永久覆盖）。 */
export function clearOverride(
  db: DatabaseSync,
  exhibitionId: string,
  photoId: string,
): void {
  db.prepare(
    `UPDATE curation_decisions
     SET user_override=NULL, override_reason=NULL, updated_at=?
     WHERE photo_id=? AND exhibition_id=?`,
  ).run(now(), photoId, exhibitionId);
}

export function getDecision(db: DatabaseSync, photoId: string): CurationDecisionDTO | null {
  const r = db.prepare("SELECT * FROM curation_decisions WHERE photo_id=?").get(photoId) as
    | CurationRow
    | undefined;
  return r ? mapRow(r) : null;
}

export function listDecisions(db: DatabaseSync, exhibitionId: string): CurationDecisionDTO[] {
  const rows = db
    .prepare(
      `SELECT c.* FROM curation_decisions c
       JOIN photo_assets p ON p.id = c.photo_id
       WHERE c.exhibition_id=? ORDER BY p.sort_order, p.created_at`,
    )
    .all(exhibitionId) as unknown as CurationRow[];
  return rows.map(mapRow);
}

export interface DecisionCounts {
  keep: number;
  hold: number;
  remove: number;
  must_keep: number;
}

/** 按 effective_decision 统计（must_keep 独立计数，不并入 keep）。 */
export function countDecisions(db: DatabaseSync, exhibitionId: string): DecisionCounts {
  const counts: DecisionCounts = { keep: 0, hold: 0, remove: 0, must_keep: 0 };
  for (const d of listDecisions(db, exhibitionId)) {
    counts[d.effective_decision] += 1;
  }
  return counts;
}
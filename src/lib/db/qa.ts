import type { DatabaseSync } from "node:sqlite";
import type { QaIssueT, QaReportT } from "../agents/schemas";
import type { QaDTO } from "@/types";
import { now } from "../id";

/**
 * 质检持久化（§10.8）。每影展一条当前行；issues 存全量发现，
 * ignored_issues 存忽略键（type+photo+chapter），跨重跑保留；status 按活跃问题重算。
 */
interface QaRow {
  exhibition_id: string;
  status: string;
  issues: string;
  passed_checks: string;
  ignored_issues: string;
  run_id: string | null;
  updated_at: string;
}

/** 忽略键：与 photo_ids 顺序无关，chapter 维度独立。 */
export function issueKey(issue: QaIssueT): string {
  return `${issue.type}|${[...issue.photo_ids].sort().join(",")}|${issue.chapter_id ?? ""}`;
}

function activeStatus(issues: QaIssueT[], ignored: Set<string>): "passed" | "needs_review" {
  const active = issues.filter((i) => !ignored.has(issueKey(i)));
  return active.some((i) => i.severity !== "low") ? "needs_review" : "passed";
}

function toDTO(r: QaRow): QaDTO {
  const issues = JSON.parse(r.issues) as QaIssueT[];
  const ignored = JSON.parse(r.ignored_issues) as string[];
  const ignoredSet = new Set(ignored);
  return {
    exhibition_id: r.exhibition_id,
    status: activeStatus(issues, ignoredSet),
    issues: issues.filter((i) => !ignoredSet.has(issueKey(i))),
    ignored_issues: issues.filter((i) => ignoredSet.has(issueKey(i))),
    ignored_keys: ignored,
    passed_checks: JSON.parse(r.passed_checks) as string[],
    run_id: r.run_id,
    updated_at: r.updated_at,
  };
}

function getRow(db: DatabaseSync, exhibitionId: string): QaRow | null {
  const r = db
    .prepare("SELECT * FROM qa_reports WHERE exhibition_id=?")
    .get(exhibitionId) as QaRow | undefined;
  return r ?? null;
}

export function getQa(db: DatabaseSync, exhibitionId: string): QaDTO | null {
  const r = getRow(db, exhibitionId);
  return r ? toDTO(r) : null;
}

/** 按 id 查 issue（含已忽略），供 ignore/fix 路由定位。 */
export function getQaIssue(db: DatabaseSync, exhibitionId: string, issueId: string): QaIssueT | null {
  const r = getRow(db, exhibitionId);
  if (!r) return null;
  return (JSON.parse(r.issues) as QaIssueT[]).find((i) => i.id === issueId) ?? null;
}

/** 写入新报告；忽略键默认延续旧行（跨重跑保留），可用 opts.ignoredKeys 显式覆盖。 */
export function replaceQa(
  db: DatabaseSync,
  exhibitionId: string,
  report: QaReportT,
  opts: { runId?: string | null; ignoredKeys?: string[] },
): QaDTO {
  const prior = getRow(db, exhibitionId);
  const ignored =
    opts.ignoredKeys ?? (prior ? (JSON.parse(prior.ignored_issues) as string[]) : []);
  const status = activeStatus(report.issues, new Set(ignored));
  db.prepare(
    `INSERT INTO qa_reports (exhibition_id, status, issues, passed_checks, ignored_issues, run_id, updated_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(exhibition_id) DO UPDATE SET
       status=excluded.status, issues=excluded.issues, passed_checks=excluded.passed_checks,
       ignored_issues=excluded.ignored_issues, run_id=excluded.run_id, updated_at=excluded.updated_at`,
  ).run(
    exhibitionId,
    status,
    JSON.stringify(report.issues),
    JSON.stringify(report.passed_checks),
    JSON.stringify(ignored),
    opts.runId ?? null,
    now(),
  );
  return getQa(db, exhibitionId)!;
}

/** 更新忽略键并按剩余活跃问题重算 status。 */
export function setIgnoredKeys(db: DatabaseSync, exhibitionId: string, keys: string[]): QaDTO {
  const r = getRow(db, exhibitionId);
  if (!r) throw new Error("qa_report_missing");
  const issues = JSON.parse(r.issues) as QaIssueT[];
  db.prepare("UPDATE qa_reports SET ignored_issues=?, status=?, updated_at=? WHERE exhibition_id=?").run(
    JSON.stringify(keys),
    activeStatus(issues, new Set(keys)),
    now(),
    exhibitionId,
  );
  return getQa(db, exhibitionId)!;
}
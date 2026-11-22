import { getDb } from "@/lib/db/client";
import { getExhibition } from "@/lib/db/repos";
import { getQa, getQaIssue, issueKey, setIgnoredKeys } from "@/lib/db/qa";
import { IgnoreIssueInput } from "@/lib/agents/schemas";
import { assertWritable } from "@/lib/orchestrator/guard";
import { ApiError, ok, handler } from "@/lib/api/errors";

import { requireVisitorMutation } from "@/lib/visitor/access";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; issueId: string }> };

/** 忽略/恢复一个 issue（键=type+photo+chapter，跨重跑保留）；status 按活跃问题重算。 */
export const POST = handler(async (req: Request, { params }: Ctx) => {
  const { id, issueId } = await params;
  const db = getDb();
  requireVisitorMutation(db, req, id);
  if (!getExhibition(db, id)) throw new ApiError(404, "not_found", "影展不存在。");
  const issue = getQaIssue(db, id, issueId);
  if (!issue) throw new ApiError(404, "issue_not_found", "质检问题不存在。");
  const qa = getQa(db, id);
  if (!qa) throw new ApiError(409, "qa_not_ready", "还没有质检报告。");
  const input = IgnoreIssueInput.parse(await req.json().catch(() => ({})));
  assertWritable(db, id);
  const keys = new Set(qa.ignored_keys);
  if (input.ignored) keys.add(issueKey(issue));
  else keys.delete(issueKey(issue));
  return ok({ qa: setIgnoredKeys(db, id, [...keys]) });
});
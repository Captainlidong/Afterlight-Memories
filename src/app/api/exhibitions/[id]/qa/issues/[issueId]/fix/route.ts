import { getDb } from "@/lib/db/client";
import { getExhibition } from "@/lib/db/repos";
import { getQa } from "@/lib/db/qa";
import { fixIssue } from "@/lib/agents/curatorialQa";
import { assertWritable } from "@/lib/orchestrator/guard";
import { ApiError, ok, handler } from "@/lib/api/errors";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; issueId: string }> };

/** 自动修复一个 issue：只动布局结构，不碰用户文案；修复后重算报告。 */
export const POST = handler(async (_req: Request, { params }: Ctx) => {
  const { id, issueId } = await params;
  const db = getDb();
  if (!getExhibition(db, id)) throw new ApiError(404, "not_found", "影展不存在。");
  assertWritable(db, id);
  const result = fixIssue(db, id, issueId);
  return ok({ ...result, qa: getQa(db, id) });
});
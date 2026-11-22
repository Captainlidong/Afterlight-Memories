import { getDb } from "@/lib/db/client";
import { getRun } from "@/lib/db/runs";
import { ApiError, ok, handler } from "@/lib/api/errors";

import { requireVisitorRead } from "@/lib/visitor/access";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; runId: string }> };

export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const { id, runId } = await params;
  requireVisitorRead(getDb(), _req, id);
  const run = getRun(getDb(), runId);
  if (!run || run.exhibition_id !== id) {
    throw new ApiError(404, "not_found", "运行记录不存在。");
  }
  return ok({ run });
});
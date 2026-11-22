import { getDb } from "@/lib/db/client";
import { getExhibition } from "@/lib/db/repos";
import { getQa } from "@/lib/db/qa";
import { ApiError, ok, handler } from "@/lib/api/errors";

import { requireVisitorRead } from "@/lib/visitor/access";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** 当前质检报告（活跃 issues + 已忽略 issues + passed_checks）；未质检 → qa null。 */
export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const db = getDb();
  requireVisitorRead(db, _req, id);
  if (!getExhibition(db, id)) throw new ApiError(404, "not_found", "影展不存在。");
  return ok({ qa: getQa(db, id) });
});
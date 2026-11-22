import { getDb } from "@/lib/db/client";
import { getExhibition } from "@/lib/db/repos";
import { listVersions } from "@/lib/db/versions";
import { ApiError, ok, handler } from "@/lib/api/errors";

import { requireVisitorRead } from "@/lib/visitor/access";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** 版本摘要列表（不含 snapshot，按 version 倒序，§10.11）。 */
export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const db = getDb();
  requireVisitorRead(db, _req, id);
  if (!getExhibition(db, id)) throw new ApiError(404, "not_found", "影展不存在。");
  return ok({ versions: listVersions(db, id) });
});
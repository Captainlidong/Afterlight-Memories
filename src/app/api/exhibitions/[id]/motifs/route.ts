import { getDb } from "@/lib/db/client";
import { getExhibition } from "@/lib/db/repos";
import { listMotifs } from "@/lib/db/motifs";
import { ApiError, ok, handler } from "@/lib/api/errors";

import { requireVisitorRead } from "@/lib/visitor/access";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** 候选主题列表（§11.6）。effective_title = user_title ?? title。 */
export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const db = getDb();
  requireVisitorRead(db, _req, id);
  if (!getExhibition(db, id)) throw new ApiError(404, "not_found", "影展不存在。");
  return ok({ motifs: listMotifs(db, id) });
});
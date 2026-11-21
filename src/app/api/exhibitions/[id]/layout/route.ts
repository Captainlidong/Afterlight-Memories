import { getDb } from "@/lib/db/client";
import { getExhibition } from "@/lib/db/repos";
import { getLayout } from "@/lib/db/layout";
import { ApiError, ok, handler } from "@/lib/api/errors";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** 当前布局（每影展一条当前行）。尚未生成 → layout: null。 */
export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const db = getDb();
  if (!getExhibition(db, id)) throw new ApiError(404, "not_found", "影展不存在。");
  return ok({ layout: getLayout(db, id) });
});
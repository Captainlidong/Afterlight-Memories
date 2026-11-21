import { getDb } from "@/lib/db/client";
import { getExhibition } from "@/lib/db/repos";
import { listRuns } from "@/lib/db/runs";
import { ApiError, ok, handler } from "@/lib/api/errors";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const db = getDb();
  if (!getExhibition(db, id)) throw new ApiError(404, "not_found", "影展不存在。");
  return ok({ runs: listRuns(db, id) });
});
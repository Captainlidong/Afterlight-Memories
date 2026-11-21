import { getDb } from "@/lib/db/client";
import { getExhibition } from "@/lib/db/repos";
import { listDecisions, countDecisions } from "@/lib/db/curation";
import { latestUndoableOperation } from "@/lib/db/curationOperations";
import { ApiError, ok, handler } from "@/lib/api/errors";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** 审美筛选结果（§11.4 / §19.5）。effective_decision = user_override ?? ai_decision。 */
export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const db = getDb();
  const exh = getExhibition(db, id);
  if (!exh) throw new ApiError(404, "not_found", "影展不存在。");
  return ok({
    decisions: listDecisions(db, id),
    counts: countDecisions(db, id),
    revision: exh.input_revision,
    latest_undoable_operation: latestUndoableOperation(db, id),
  });
});
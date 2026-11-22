import { getDb } from "@/lib/db/client";
import { getExhibition } from "@/lib/db/repos";
import { getMotif, updateMotif } from "@/lib/db/motifs";
import { UpdateMotifInput } from "@/lib/agents/schemas";
import { assertWritable } from "@/lib/orchestrator/guard";
import { ApiError, ok, handler } from "@/lib/api/errors";

import { requireVisitorMutation } from "@/lib/visitor/access";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; motifId: string }> };

/**
 * 主题改名 / 拒绝（§8.7）。改名只写 user_title（title 不变）；
 * 拒绝已选主题时清空 selected_motif_id（重新关门）。不触发重跑。
 */
export const PATCH = handler(async (req: Request, { params }: Ctx) => {
  const { id, motifId } = await params;
  const db = getDb();
  requireVisitorMutation(db, req, id);
  if (!getExhibition(db, id)) throw new ApiError(404, "not_found", "影展不存在。");
  const motif = getMotif(db, motifId);
  if (!motif || motif.exhibition_id !== id) {
    throw new ApiError(404, "not_found", "主题不存在。");
  }
  const input = UpdateMotifInput.parse(await req.json());
  assertWritable(db, id);
  updateMotif(db, id, motifId, {
    user_title: input.title,
    state: input.state,
  });
  return ok({ motif: getMotif(db, motifId) });
});
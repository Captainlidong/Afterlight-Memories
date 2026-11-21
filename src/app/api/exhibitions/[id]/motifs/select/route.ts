import { getDb } from "@/lib/db/client";
import { getExhibition } from "@/lib/db/repos";
import { getMotif, selectMotif } from "@/lib/db/motifs";
import { getNarrative } from "@/lib/db/narrative";
import { markStale } from "@/lib/orchestrator/rerunMatrix";
import { assertWritable } from "@/lib/orchestrator/guard";
import { SelectMotifInput } from "@/lib/agents/schemas";
import { ApiError, ok, handler } from "@/lib/api/errors";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 选择主题主线（§11.7 / §5.1 GATE）。写入 selected_motif_id，开启叙事门。
 * custom_title 为用户对该主线的命名（effective_title）。不自动触发叙事（阶段 4 接线）。
 */
export const POST = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const db = getDb();
  if (!getExhibition(db, id)) throw new ApiError(404, "not_found", "影展不存在。");
  const input = SelectMotifInput.parse(await req.json());
  assertWritable(db, id);
  const motif = getMotif(db, input.motif_id);
  if (!motif || motif.exhibition_id !== id) {
    throw new ApiError(404, "not_found", "主题不存在。");
  }
  selectMotif(db, id, input.motif_id, input.custom_title);
  // 换主线 → 叙事及之后过期（重跑矩阵 select_theme）；首次选择（尚无叙事）不留横幅。
  if (getNarrative(db, id)) markStale(db, id, "narrative");
  return ok({ motif: getMotif(db, input.motif_id), selected_motif_id: input.motif_id });
});
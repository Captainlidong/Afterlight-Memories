import { getDb } from "@/lib/db/client";
import { getExhibition } from "@/lib/db/repos";
import { getNarrative, replaceNarrative } from "@/lib/db/narrative";
import { upsertEdit, listEdits } from "@/lib/db/edits";
import { listDecisions } from "@/lib/db/curation";
import { mergeNarrative, assertNarrativeEdits, assertNarrativeStructure } from "@/lib/orchestrator/merge";
import { getMotif } from "@/lib/db/motifs";
import { markStale } from "@/lib/orchestrator/rerunMatrix";
import { assertWritable } from "@/lib/orchestrator/guard";
import { UpdateNarrativeInput, type NarrativePlanT } from "@/lib/agents/schemas";
import { ApiError, ok, handler } from "@/lib/api/errors";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** 当前叙事 + 用户编辑覆盖层（§11.9）。 */
export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const db = getDb();
  if (!getExhibition(db, id)) throw new ApiError(404, "not_found", "影展不存在。");
  return ok({ narrative: getNarrative(db, id), edits: listEdits(db, id) });
});

/** 结构编辑（章节/照片顺序、跨章归属、放置）触发 layout 重跑标记；纯文本/锁定不重跑。 */
function isStructural(path: string): boolean {
  if (path === "narrative.chapter_order") return true;
  if (path.startsWith("chapter:") && path.endsWith(".photo_order")) return true;
  if (path.startsWith("photo:") && (path.endsWith(".membership") || path.endsWith(".placement"))) return true;
  return false;
}

/**
 * 用户编辑叙事（§11.9 / 提示词8）。写覆盖层后立即对当前叙事回放合并（幂等），
 * 不重跑 AI、不 bump 版本。锁定行同样落覆盖层，重生成时由 merge 保留。
 */
export const PATCH = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  // 不跨 await 持有快照或写锁。最新读取、运行占用检查、双 CAS 和全部落库在同一短事务。
  const input = UpdateNarrativeInput.parse(await req.json());
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const exh = getExhibition(db, id);
    if (!exh) throw new ApiError(404, "not_found", "影展不存在。");
    assertWritable(db, id);
    const current = getNarrative(db, id);
    if (!current) throw new ApiError(409, "no_narrative", "请先生成叙事，再编辑文案。");
    if (input.expected_version !== exh.current_version || input.expected_edit_revision !== current.edit_revision) {
      throw new ApiError(409, "version_conflict", "内容已在其他操作中更新，你的草稿已保留，请查看最新内容后再保存。");
    }
    const decisions = listDecisions(db, id);
    const keepIds = decisions.filter((d) => d.effective_decision === "keep" || d.effective_decision === "must_keep").map((d) => d.photo_id);
    const mustKeepIds = decisions.filter((d) => d.effective_decision === "must_keep").map((d) => d.photo_id);
    const motif = current.selected_motif_id ? getMotif(db, current.selected_motif_id) : null;
    if (current.selected_motif_id && (!motif || motif.exhibition_id !== id)) {
      throw new ApiError(422, "narrative_structure", "叙事主线引用已失效，请重新选择主题。");
    }
    const mergeContext = { keepIds, mustKeepIds, motifPhotoIds: motif?.photo_ids };
    const base: NarrativePlanT = {
      selected_motif_id: current.selected_motif_id ?? undefined,
      title: current.title, subtitle: current.subtitle, curatorial_statement: current.curatorial_statement,
      chapters: current.chapters, tone: current.tone,
    };
    for (const e of input.edits) upsertEdit(db, id, e.target_path, e.value, e.locked ?? false);
    const edits = listEdits(db, id);
    assertNarrativeEdits(base, edits, mergeContext);
    const merged = mergeNarrative(base, edits, mergeContext);
    assertNarrativeStructure(merged, mergeContext);
    assertNarrativeEdits(merged, edits, mergeContext, true);
    if (input.edits.some((e) => isStructural(e.target_path))) markStale(db, id, "layout");
    replaceNarrative(db, id, merged, {
      source: current.source, inputVersion: current.input_version,
      runId: current.run_id, selectedMotifId: current.selected_motif_id,
    });
    const result = { narrative: getNarrative(db, id), edits: listEdits(db, id) };
    db.exec("COMMIT");
    return ok(result);
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
});
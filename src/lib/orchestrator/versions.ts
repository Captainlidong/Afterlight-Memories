import type { DatabaseSync } from "node:sqlite";
import { getExhibition, updateExhibition, bumpInputRevision } from "../db/repos";
import { getNarrative, replaceNarrative } from "../db/narrative";
import { listMotifs } from "../db/motifs";
import { listDecisions } from "../db/curation";
import { listEdits } from "../db/edits";
import { insertVersion, getVersion, pruneVersions } from "../db/versions";
import { getLayout, replaceLayout, deleteLayout } from "../db/layout";
import { ExhibitionLayout } from "../agents/schemas";
import { now } from "../id";
import { ApiError } from "../api/errors";
import type { LayoutSectionT } from "../agents/schemas";
import type { NarrativeDTO, MotifDTO, CurationDecisionDTO, UserEditDTO, LayoutDTO } from "@/types";

/**
 * 版本快照与回滚（设计文档 §10.11 / 提示词8 / v3 R04）。
 * snapshotVersion：每次叙事/布局/质检生成成功 + 破坏性操作前写一版，bump current_version，保留最近 10 个。
 * restoreVersion：单事务全保真恢复 narrative/motifs/decisions/user_edits/layout（含 id/created_at/state/锁定）
 * + template/selected_motif_id/tone + 确认状态；失效照片引用被清理，input_revision 前进以隔离旧回调，
 * 然后把恢复后的状态再记一版（历史不丢）。旧快照无布局时删除当前布局并标记需重建。
 */
export interface ExhibitionSnapshot {
  narrative: NarrativeDTO | null;
  motifs: MotifDTO[];
  decisions: CurationDecisionDTO[];
  user_edits: UserEditDTO[];
  template: string;
  selected_motif_id: string | null;
  tone: string;
  layout: LayoutDTO | null;
  /** R04：确认状态随快照恢复；旧快照无此字段视为未确认。 */
  selection_confirmed_photo_ids?: string[] | null;
  selection_hold_policy?: "exclude" | "include" | null;
}

export function buildSnapshot(db: DatabaseSync, exhibitionId: string): ExhibitionSnapshot {
  const exh = getExhibition(db, exhibitionId);
  if (!exh) throw new ApiError(404, "not_found", "影展不存在。");
  return {
    narrative: getNarrative(db, exhibitionId),
    motifs: listMotifs(db, exhibitionId),
    decisions: listDecisions(db, exhibitionId),
    user_edits: listEdits(db, exhibitionId),
    template: exh.template,
    selected_motif_id: exh.selected_motif_id,
    tone: exh.tone,
    layout: getLayout(db, exhibitionId),
    selection_confirmed_photo_ids: exh.selection_confirmed_photo_ids,
    selection_hold_policy: exh.selection_hold_policy,
  };
}

export function snapshotVersion(db: DatabaseSync, exhibitionId: string, label?: string | null): number {
  const exh = getExhibition(db, exhibitionId);
  if (!exh) throw new ApiError(404, "not_found", "影展不存在。");
  const version = exh.current_version + 1;
  insertVersion(db, exhibitionId, version, buildSnapshot(db, exhibitionId), label ?? null);
  updateExhibition(db, exhibitionId, { current_version: version });
  pruneVersions(db, exhibitionId, 10);
  return version;
}

/** 叙事章节里剔除已删除照片；整章空掉则丢弃该章。 */
function sanitizeNarrative(n: NarrativeDTO | null, photos: Set<string>): NarrativeDTO | null {
  if (!n) return null;
  const chapters = (n.chapters ?? [])
    .map((ch) => {
      const photoIds = ch.photo_ids.filter((id) => photos.has(id));
      const keep = (id: string | undefined) => (id && photoIds.includes(id) ? id : undefined);
      return {
        ...ch,
        photo_ids: photoIds,
        opening_photo_id: keep(ch.opening_photo_id),
        closing_photo_id: keep(ch.closing_photo_id),
        placement_reasons: (ch.placement_reasons ?? []).filter((r) => photoIds.includes(r.photo_id)),
      };
    })
    .filter((ch) => ch.photo_ids.length > 0);
  if (chapters.length === 0) return null;
  return { ...n, chapters };
}

/** 主题里剔除已删除照片；空主题丢弃，丢失的主线状态回到 proposed。 */
function sanitizeMotifs(motifs: MotifDTO[], photos: Set<string>, selectedId: string | null): {
  motifs: MotifDTO[];
  selectedId: string | null;
} {
  const kept = (motifs ?? [])
    .map((m) => ({ ...m, photo_ids: m.photo_ids.filter((id) => photos.has(id)) }))
    .filter((m) => m.photo_ids.length > 0);
  const ids = new Set(kept.map((m) => m.id));
  const selected = selectedId && ids.has(selectedId) ? selectedId : null;
  return {
    motifs: kept.map((m) => (m.state === "selected" && m.id !== selected ? { ...m, state: "proposed" } : m)),
    selectedId: selected,
  };
}

/** 用户编辑覆盖层：引用了已删照片/已丢弃章节的行一并清理。 */
function sanitizeEdits(edits: UserEditDTO[], photos: Set<string>, chapters: Set<string>): UserEditDTO[] {
  const out: UserEditDTO[] = [];
  for (const e of edits) {
    const photoRef = /^photo:([^.]+)\.(membership|placement)$/.exec(e.target_path);
    if (photoRef) {
      if (!photos.has(photoRef[1])) continue;
      if (photoRef[2] === "membership" && typeof e.value === "string" && !chapters.has(e.value)) continue;
      out.push(e);
      continue;
    }
    const chapterRef = /^chapter:([^.]+)\.(.+)$/.exec(e.target_path);
    if (chapterRef) {
      if (chapters.size > 0 && !chapters.has(chapterRef[1])) continue;
      if (chapterRef[2] === "photo_order") {
        if (!Array.isArray(e.value)) continue;
        const ids = e.value.filter((id): id is string => typeof id === "string" && photos.has(id));
        if (ids.length === 0) continue;
        out.push({ ...e, value: ids });
        continue;
      }
    }
    if (e.target_path === "narrative.chapter_order") {
      if (!Array.isArray(e.value) || chapters.size === 0) continue;
      const ids = e.value.filter((id): id is string => typeof id === "string" && chapters.has(id));
      if (ids.length === 0) continue;
      out.push({ ...e, value: ids });
      continue;
    }
    out.push(e);
  }
  return out;
}

/** 布局：剔除已删照片/章节引用；某段照片不足或整份失效 → 该段丢弃/布局为空。 */
function sanitizeLayout(
  layout: LayoutDTO | null,
  photos: Set<string>,
  chapters: Set<string>,
): ReturnType<typeof ExhibitionLayout.parse> | null {
  if (!layout || !Array.isArray(layout.sections)) return null;
  const sections: LayoutSectionT[] = [];
  for (const s of layout.sections) {
    switch (s.type) {
      case "hero":
      case "single_image":
        if (photos.has(s.photo_id)) sections.push(s);
        break;
      case "image_pair": {
        const ids = s.photo_ids.filter((id) => photos.has(id));
        if (ids.length === 2) sections.push({ ...s, photo_ids: [ids[0], ids[1]] });
        break;
      }
      case "image_group": {
        const ids = s.photo_ids.filter((id) => photos.has(id)).slice(0, 4);
        if (ids.length >= 2) sections.push({ ...s, photo_ids: ids });
        break;
      }
      case "ending": {
        const ids = s.photo_ids.filter((id) => photos.has(id)).slice(0, 2);
        if (ids.length >= 1) sections.push({ ...s, photo_ids: ids });
        break;
      }
      case "chapter_intro":
        if (chapters.has(s.chapter_id)) sections.push(s);
        break;
      case "statement":
        if (s.chapter_id && !chapters.has(s.chapter_id)) {
          sections.push({ ...s, chapter_id: undefined });
        } else {
          sections.push(s);
        }
        break;
      default:
        sections.push(s);
    }
  }
  const parsed = ExhibitionLayout.safeParse({
    template: layout.template,
    background: layout.background,
    text_color: layout.text_color,
    sections,
  });
  return parsed.success ? parsed.data : null;
}

function sameSet(a: string[], b: Set<string>): boolean {
  return a.length === b.size && a.every((id) => b.has(id));
}

export function restoreVersion(db: DatabaseSync, exhibitionId: string, version: number): number {
  const v = getVersion(db, exhibitionId, version);
  if (!v) throw new ApiError(404, "version_not_found", `版本 ${version} 不存在。`);
  const snap = v.snapshot as ExhibitionSnapshot;
  const before = getExhibition(db, exhibitionId);
  if (!before) throw new ApiError(404, "not_found", "影展不存在。");

  const existingPhotos = new Set(
    (db.prepare("SELECT id FROM photo_assets WHERE exhibition_id=?").all(exhibitionId) as unknown as { id: string }[]).map(
      (r) => r.id,
    ),
  );
  const narrative = sanitizeNarrative(snap.narrative, existingPhotos);
  const chapterIds = new Set((narrative?.chapters ?? []).map((c) => c.id));
  const { motifs, selectedId } = sanitizeMotifs(snap.motifs ?? [], existingPhotos, snap.selected_motif_id);
  const decisions = (snap.decisions ?? []).filter((d) => existingPhotos.has(d.photo_id));
  const edits = sanitizeEdits(snap.user_edits ?? [], existingPhotos, chapterIds);
  const layout = sanitizeLayout(snap.layout, existingPhotos, chapterIds);
  const keepIds = new Set(
    decisions.filter((d) => d.effective_decision === "keep" || d.effective_decision === "must_keep").map((d) => d.photo_id),
  );
  const confirmedIds = snap.selection_confirmed_photo_ids ?? null;
  const confirmValid =
    confirmedIds != null && confirmedIds.length > 0 && confirmedIds.every((id) => existingPhotos.has(id)) && sameSet(confirmedIds, keepIds);
  if (narrative) narrative.selected_motif_id = selectedId;

  db.exec("BEGIN IMMEDIATE");
  try {
    if (narrative) {
      replaceNarrative(db, exhibitionId, { ...narrative, selected_motif_id: narrative.selected_motif_id ?? undefined }, {
        source: narrative.source, inputVersion: narrative.input_version,
        runId: narrative.run_id, selectedMotifId: narrative.selected_motif_id,
      });
    } else {
      // 当前行可删除，高水位不随快照恢复，后续生成仍使用更大的修订。
      db.prepare("UPDATE exhibitions SET narrative_edit_revision=narrative_edit_revision+1 WHERE id=?").run(exhibitionId);
      db.prepare("DELETE FROM narrative_plans WHERE exhibition_id=?").run(exhibitionId);
    }

    db.prepare("DELETE FROM motifs WHERE exhibition_id=?").run(exhibitionId);
    const mstmt = db.prepare(
      `INSERT INTO motifs
        (id, exhibition_id, title, user_title, description, photo_ids, evidence, confidence, alternative_readings, state, run_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const m of motifs) {
      mstmt.run(
        m.id, exhibitionId, m.title, m.user_title, m.description, JSON.stringify(m.photo_ids),
        JSON.stringify(m.evidence), m.confidence, JSON.stringify(m.alternative_readings), m.state, m.run_id, m.created_at,
      );
    }

    db.prepare("DELETE FROM curation_decisions WHERE exhibition_id=?").run(exhibitionId);
    const dstmt = db.prepare(
      `INSERT INTO curation_decisions
        (photo_id, exhibition_id, ai_decision, score, confidence, reasons, related_photo_ids, user_override, override_reason, run_id, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const d of decisions) {
      dstmt.run(
        d.photo_id, exhibitionId, d.ai_decision, d.score, d.confidence, JSON.stringify(d.reasons),
        JSON.stringify(d.related_photo_ids), d.user_override, d.override_reason, d.run_id, d.updated_at,
      );
    }

    db.prepare("DELETE FROM user_edits WHERE exhibition_id=?").run(exhibitionId);
    const estmt = db.prepare(
      `INSERT INTO user_edits (id, exhibition_id, target_path, value_json, locked, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    );
    for (const e of edits) {
      estmt.run(e.id, exhibitionId, e.target_path, JSON.stringify(e.value), e.locked ? 1 : 0, e.created_at, e.updated_at);
    }

    // R04：布局随快照恢复；旧快照无布局时必须移除当前布局，不能留下另一个模板的成品。
    if (layout) replaceLayout(db, exhibitionId, layout, { inputVersion: before.current_version });
    else deleteLayout(db, exhibitionId);

    db.prepare("UPDATE exhibitions SET template=?, selected_motif_id=?, tone=?, updated_at=? WHERE id=?").run(
      snap.template, selectedId, snap.tone, now(), exhibitionId,
    );

    // 推进输入修订：旧进程/旧回调据此认出自己的结果已过期。
    const revision = bumpInputRevision(db, exhibitionId);
    updateExhibition(db, exhibitionId, {
      selection_confirmed_revision: confirmValid ? revision : null,
      selection_confirmed_photo_ids: confirmValid ? JSON.stringify(confirmedIds) : null,
      selection_hold_policy: confirmValid ? (snap.selection_hold_policy ?? null) : null,
    });
    if (before.status !== "draft" && before.status !== "uploading") {
      updateExhibition(db, exhibitionId, { stale_from: layout ? null : narrative ? "layout" : "narrative" });
    }
    const restoredVersion = snapshotVersion(db, exhibitionId, `回滚到版本 ${version}`);
    db.exec("COMMIT");
    return restoredVersion;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

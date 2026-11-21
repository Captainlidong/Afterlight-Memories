import type { DatabaseSync } from "node:sqlite";
import { listPhotos, listInspections } from "../db/photos";
import { listDecisions } from "../db/curation";
import { getNarrative } from "../db/narrative";
import { getLayout, replaceLayout } from "../db/layout";
import { getQa, replaceQa } from "../db/qa";
import { updateExhibition } from "../db/repos";
import { snapshotVersion } from "../orchestrator/versions";
import { ApiError } from "../api/errors";
import { checkNarrativeCredibility } from "./credibility";
import {
  ExhibitionLayout,
  QaReport,
  type ExhibitionLayoutT,
  type LayoutSectionT,
  type NarrativePlanT,
  type QaIssueT,
  type QaReportT,
} from "./schemas";
import type { Exhibition } from "@/types";

/**
 * Agent 6 策展质检官（§6.7 / §12.8）。纯规则引擎查当前落库结果，两模式一致：
 * 跨 section 重复、≥3 相似连续满屏、章节无起伏、文案可信度复扫、must_keep 在场、
 * 移动端溢出启发式、章节标题重复、结尾突兀、坏文件、隐私提示（无模型不假检测）。
 * 忽略键跨重跑保留（db/qa）；自动修复只动布局结构，不碰用户文案。
 */
export interface QaPhoto {
  id: string;
  status: string;
  width: number | null;
  height: number | null;
  subjects: string[];
  duplicate_group_id: string | null;
}

export interface QaInput {
  layout: ExhibitionLayoutT;
  narrative: NarrativePlanT;
  photos: QaPhoto[];
  keepIds: string[];
  mustKeepIds: string[];
}

function sectionRefs(s: LayoutSectionT): string[] {
  switch (s.type) {
    case "hero":
    case "single_image":
      return [s.photo_id];
    case "image_pair":
    case "image_group":
    case "ending":
      return s.photo_ids;
    default:
      return [];
  }
}

function similar(a: QaPhoto | undefined, b: QaPhoto | undefined): boolean {
  if (!a || !b) return false;
  if (a.duplicate_group_id && a.duplicate_group_id === b.duplicate_group_id) return true;
  return a.subjects.some((s) => b.subjects.includes(s));
}

const isPortrait = (p: QaPhoto | undefined) =>
  !!p && p.width != null && p.height != null && p.height > 0 && p.width / p.height < 0.8;

export function computeQa(input: QaInput): QaReportT {
  const { layout, narrative, photos, keepIds, mustKeepIds } = input;
  const byId = new Map(photos.map((p) => [p.id, p]));
  const issues: QaIssueT[] = [];
  const passed: string[] = [];
  const counters = new Map<string, number>();
  const push = (issue: Omit<QaIssueT, "id">) => {
    const n = (counters.get(issue.type) ?? 0) + 1;
    counters.set(issue.type, n);
    issues.push({ ...issue, id: `qa_${issue.type}_${n}` });
  };

  // 1 跨 section 重复
  const refCount = new Map<string, number>();
  for (const s of layout.sections) {
    for (const pid of sectionRefs(s)) refCount.set(pid, (refCount.get(pid) ?? 0) + 1);
  }
  const dups = [...refCount.entries()].filter(([, n]) => n > 1).map(([pid]) => pid);
  if (dups.length === 0) passed.push("跨 section 无重复");
  for (const pid of dups) {
    push({
      severity: "high",
      type: "repetition",
      message: `同一张照片出现在 ${refCount.get(pid)} 个 section，打破「每张照片只出现一次」的观看约定。`,
      photo_ids: [pid],
      auto_fix_available: true,
    });
  }

  // 2 ≥3 相似连续满屏
  let run: string[] = [];
  const flushRun = () => {
    if (run.length >= 3) {
      push({
        severity: "medium",
        type: "similar_run",
        message: `${run.length} 张相似照片连续满屏，观看节奏单调，建议合并为组或插入留白。`,
        photo_ids: [...run],
        auto_fix_available: true,
      });
    }
    run = [];
  };
  for (const s of layout.sections) {
    if (s.type === "single_image" && (s.size === "large" || s.size === "full")) {
      const pid = s.photo_id;
      if (run.length > 0 && !similar(byId.get(run[run.length - 1]), byId.get(pid))) flushRun();
      run.push(pid);
    } else flushRun();
  }
  flushRun();
  if (!issues.some((i) => i.type === "similar_run")) passed.push("无 ≥3 相似连续满屏");

  // 3 章节节奏（body 内 ≥3 张同尺寸 single）
  let currentChapter: string | null = null;
  let bodySizes: string[] = [];
  const flushBody = () => {
    if (currentChapter && bodySizes.length >= 3 && new Set(bodySizes).size === 1) {
      push({
        severity: "low",
        type: "chapter_rhythm",
        message: `章节内 ${bodySizes.length} 张照片尺寸一致，缺少大小起伏带来的呼吸感。`,
        photo_ids: [],
        chapter_id: currentChapter,
        auto_fix_available: false,
      });
    }
    bodySizes = [];
  };
  for (const s of layout.sections) {
    if (s.type === "chapter_intro") {
      flushBody();
      currentChapter = s.chapter_id;
    } else if (s.type === "single_image") bodySizes.push(s.size);
    else if (s.type === "statement" || s.type === "ending") flushBody();
  }
  flushBody();
  if (!issues.some((i) => i.type === "chapter_rhythm")) passed.push("章节节奏有起伏");

  // 4 文案可信度复扫（与叙事共用校验器）
  const cred = checkNarrativeCredibility(narrative, { keepIds });
  if (cred.ok) passed.push("文案可信边界复扫通过");
  for (const v of cred.violations) {
    const m = /^chapter:([^.]+)\./.exec(v.path);
    push({
      severity: "high",
      type: "credibility",
      message: v.message,
      photo_ids: v.photo_ids ?? [],
      chapter_id: m ? m[1] : undefined,
      auto_fix_available: false,
    });
  }

  // 5 must_keep 在场
  const refSet = new Set(refCount.keys());
  const missing = mustKeepIds.filter((pid) => !refSet.has(pid));
  if (missing.length === 0) passed.push("must_keep 全部在场");
  else
    push({
      severity: "high",
      type: "must_keep_missing",
      message: `标记为「必须保留」的照片未出现在影展中：${missing.length} 张。`,
      photo_ids: missing,
      auto_fix_available: true,
    });

  // 6 移动端溢出启发式（≥3 列组含竖图）
  let overflow = false;
  for (const s of layout.sections) {
    if (s.type === "image_group" && s.photo_ids.length >= 3 && s.photo_ids.some((pid) => isPortrait(byId.get(pid)))) {
      overflow = true;
      push({
        severity: "medium",
        type: "mobile_overflow",
        message: `${s.photo_ids.length} 列图片组含竖图，窄屏下单张过窄，建议拆为两组。`,
        photo_ids: [...s.photo_ids],
        auto_fix_available: true,
      });
    }
  }
  if (!overflow) passed.push("移动端无溢出启发式告警");

  // 7 章节标题重复
  const titles = new Map<string, string>();
  let dupTitle = false;
  for (const c of narrative.chapters) {
    if (titles.has(c.title)) {
      dupTitle = true;
      push({
        severity: "medium",
        type: "duplicate_title",
        message: `章节标题「${c.title}」重复，观众无法区分章节。`,
        photo_ids: [],
        chapter_id: c.id,
        auto_fix_available: false,
      });
    } else titles.set(c.title, c.id);
  }
  if (!dupTitle) passed.push("章节标题无重复");

  // 8 结尾收束
  const last = layout.sections[layout.sections.length - 1];
  if (last?.type === "ending") passed.push("结尾有收束");
  else
    push({
      severity: "medium",
      type: "abrupt_ending",
      message: "影展缺少结尾收束段，结束显得突兀，建议重新排版生成 ending。",
      photo_ids: [],
      auto_fix_available: false,
    });

  // 9 坏文件
  const broken = photos.filter((p) => p.status === "failed").map((p) => p.id);
  if (broken.length === 0) passed.push("无损坏文件");
  else
    push({
      severity: "medium",
      type: "broken_file",
      message: `${broken.length} 个文件解析失败，建议删除或重新上传。`,
      photo_ids: broken,
      auto_fix_available: false,
    });

  // 10 隐私提示（无模型不假检测）
  push({
    severity: "low",
    type: "privacy_hint",
    message: "发布前请人工检查人脸、车牌、门牌地址等隐私信息；本工具不做自动人脸检测。",
    photo_ids: [],
    auto_fix_available: false,
  });

  return {
    status: issues.some((i) => i.severity !== "low") ? "needs_review" : "passed",
    issues,
    passed_checks: passed,
  };
}

/** 确定性自动修复：只改布局结构（去重/合组/补 must_keep/拆组），不碰用户文案。不可修复返回 null。 */
export function applyQaFix(layout: ExhibitionLayoutT, issue: QaIssueT): ExhibitionLayoutT | null {
  const sections = [...layout.sections];
  const without = (s: LayoutSectionT, pid: string): LayoutSectionT | null => {
    switch (s.type) {
      case "hero":
      case "single_image":
        return s.photo_id === pid ? null : s;
      case "image_pair": {
        const rest = s.photo_ids.filter((id) => id !== pid);
        if (rest.length === 2) return s;
        if (rest.length === 1) return { id: s.id, type: "single_image", photo_id: rest[0], size: "medium", spacing: "medium" };
        return null;
      }
      case "image_group": {
        const rest = s.photo_ids.filter((id) => id !== pid);
        if (rest.length >= 2) return { ...s, photo_ids: rest };
        if (rest.length === 1) return { id: s.id, type: "single_image", photo_id: rest[0], size: "medium", spacing: "medium" };
        return null;
      }
      case "ending": {
        const rest = s.photo_ids.filter((id) => id !== pid);
        return rest.length >= 1 ? { ...s, photo_ids: rest } : null;
      }
      default:
        return s;
    }
  };

  if (issue.type === "repetition") {
    const pid = issue.photo_ids[0];
    let seen = false;
    const next: LayoutSectionT[] = [];
    for (const s of sections) {
      if (!sectionRefs(s).includes(pid)) {
        next.push(s);
        continue;
      }
      if (!seen) {
        seen = true;
        next.push(s);
        continue;
      }
      const reduced = without(s, pid);
      if (reduced) next.push(reduced);
    }
    return { ...layout, sections: next };
  }

  if (issue.type === "similar_run") {
    const runIds = new Set(issue.photo_ids);
    const start = sections.findIndex((s) => s.type === "single_image" && runIds.has(s.photo_id));
    if (start < 0) return null;
    let end = start;
    while (
      end < sections.length &&
      sections[end].type === "single_image" &&
      runIds.has((sections[end] as { photo_id: string }).photo_id)
    )
      end++;
    const merged: LayoutSectionT[] = [];
    for (let i = start; i < end; i += 4) {
      const chunk = issue.photo_ids.slice(i - start, i - start + 4);
      merged.push(
        chunk.length >= 2
          ? { id: i === start ? sections[start].id : `${sections[start].id}_g${i}`, type: "image_group", photo_ids: chunk, gap: "small" }
          : { id: `${sections[start].id}_s${i}`, type: "single_image", photo_id: chunk[0], size: "medium", spacing: "medium" },
      );
    }
    return { ...layout, sections: [...sections.slice(0, start), ...merged, ...sections.slice(end)] };
  }

  if (issue.type === "must_keep_missing") {
    const endIdx = sections.findIndex((s) => s.type === "ending");
    const at = endIdx >= 0 ? endIdx : sections.length;
    const added: LayoutSectionT[] = issue.photo_ids.map((pid) => ({
      id: `mk_${pid}`,
      type: "single_image",
      photo_id: pid,
      size: "medium",
      spacing: "medium",
    }));
    return { ...layout, sections: [...sections.slice(0, at), ...added, ...sections.slice(at)] };
  }

  if (issue.type === "mobile_overflow") {
    const idx = sections.findIndex((s) => s.type === "image_group" && s.photo_ids.join(",") === issue.photo_ids.join(","));
    if (idx < 0) return null;
    const ids = issue.photo_ids;
    const split: LayoutSectionT[] = [];
    for (let i = 0; i < ids.length; i += 2) {
      const chunk = ids.slice(i, i + 2);
      split.push(
        chunk.length === 2
          ? { id: i === 0 ? sections[idx].id : `${sections[idx].id}_b${i}`, type: "image_group", photo_ids: chunk, gap: "small" }
          : { id: `${sections[idx].id}_s${i}`, type: "single_image", photo_id: chunk[0], size: "medium", spacing: "medium" },
      );
    }
    return { ...layout, sections: [...sections.slice(0, idx), ...split, ...sections.slice(idx + 1)] };
  }

  return null;
}

export interface QaOutput {
  status: "passed" | "needs_review";
  issue_count: number;
  auto_fixable: number;
  ignored_count: number;
  source: "rules";
  version: number;
}

/** 编排器入口：读当前落库结果跑规则引擎，落 qa_reports（忽略键延续）+ 版本快照 + 清 stale。 */
export async function runQa(
  db: DatabaseSync,
  ctx: { runId: string; exhibition: Exhibition; assertOwner?: () => void },
): Promise<QaOutput> {
  const exh = ctx.exhibition;
  const layout = getLayout(db, exh.id);
  if (!layout) throw new ApiError(409, "layout_not_ready", "请先生成布局，再进行策展质检。");
  const narrative = getNarrative(db, exh.id);
  if (!narrative) throw new ApiError(409, "narrative_not_ready", "请先生成叙事，再进行策展质检。");

  const photos = listPhotos(db, exh.id);
  const inspections = new Map(listInspections(db, exh.id).map((i) => [i.photo_id, i]));
  const decisions = listDecisions(db, exh.id);
  const keepIds = decisions
    .filter((d) => d.effective_decision === "keep" || d.effective_decision === "must_keep")
    .map((d) => d.photo_id);
  const mustKeepIds = decisions.filter((d) => d.effective_decision === "must_keep").map((d) => d.photo_id);

  const plan: NarrativePlanT = {
    title: narrative.title,
    subtitle: narrative.subtitle,
    curatorial_statement: narrative.curatorial_statement,
    chapters: narrative.chapters,
    tone: narrative.tone,
  };
  const report = QaReport.parse(
    computeQa({
      layout: { template: layout.template, background: layout.background, text_color: layout.text_color, sections: layout.sections },
      narrative: plan,
      photos: photos.map((p) => {
        const ins = inspections.get(p.id);
        return {
          id: p.id,
          status: p.status,
          width: p.width,
          height: p.height,
          subjects: ins?.subjects ?? [],
          duplicate_group_id: ins?.duplicate_group_id ?? null,
        };
      }),
      keepIds,
      mustKeepIds,
    }),
  );

  let dto: ReturnType<typeof replaceQa>;
  let version: number;
  db.exec("BEGIN IMMEDIATE");
  try {
    ctx.assertOwner?.();
    dto = replaceQa(db, exh.id, report, { runId: ctx.runId });
    version = snapshotVersion(db, exh.id, "策展质检");
    updateExhibition(db, exh.id, { stale_from: null });
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }

  return {
    status: dto.status,
    issue_count: dto.issues.length,
    auto_fixable: dto.issues.filter((i) => i.auto_fix_available).length,
    ignored_count: dto.ignored_keys.length,
    source: "rules",
    version,
  };
}

/** 自动修复落库：改布局 + 重算质检（忽略键延续），不写用户文案。 */
export function fixIssue(db: DatabaseSync, exhibitionId: string, issueId: string): { layout: ExhibitionLayoutT; issue_count: number } {
  const layout = getLayout(db, exhibitionId);
  const qa = getQa(db, exhibitionId);
  if (!layout || !qa) throw new ApiError(409, "qa_not_ready", "请先生成布局与质检报告。");
  const issue = qa.issues.find((i) => i.id === issueId);
  if (!issue) throw new ApiError(404, "issue_not_found", "问题不存在或已被忽略/修复。");
  if (!issue.auto_fix_available) throw new ApiError(400, "not_auto_fixable", "该问题不支持自动修复，请手动处理或忽略。");

  const photos = listPhotos(db, exhibitionId);
  const inspections = new Map(listInspections(db, exhibitionId).map((i) => [i.photo_id, i]));
  const fixed = applyQaFix(
    { template: layout.template, background: layout.background, text_color: layout.text_color, sections: layout.sections },
    issue,
  );
  if (!fixed) throw new ApiError(400, "fix_failed", "自动修复无法应用，请重新排版。");
  const parsed = ExhibitionLayout.parse(fixed);
  const report = QaReport.parse(
    computeQa({
      layout: parsed,
      narrative: narrativePlanOf(db, exhibitionId),
      photos: photos.map((p) => {
        const ins = inspections.get(p.id);
        return { id: p.id, status: p.status, width: p.width, height: p.height, subjects: ins?.subjects ?? [], duplicate_group_id: ins?.duplicate_group_id ?? null };
      }),
      keepIds: listDecisions(db, exhibitionId)
        .filter((d) => d.effective_decision === "keep" || d.effective_decision === "must_keep")
        .map((d) => d.photo_id),
      mustKeepIds: listDecisions(db, exhibitionId).filter((d) => d.effective_decision === "must_keep").map((d) => d.photo_id),
    }),
  );
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    replaceLayout(db, exhibitionId, parsed, { inputVersion: layout.input_version, runId: layout.run_id });
    const dto = replaceQa(db, exhibitionId, report, { runId: layout.run_id });
    if (ownsTransaction) db.exec("COMMIT");
    return { layout: parsed, issue_count: dto.issues.length };
  } catch (error) {
    if (ownsTransaction && db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

function narrativePlanOf(db: DatabaseSync, exhibitionId: string): NarrativePlanT {
  const n = getNarrative(db, exhibitionId);
  if (!n) throw new ApiError(409, "narrative_not_ready", "请先生成叙事。");
  return { title: n.title, subtitle: n.subtitle, curatorial_statement: n.curatorial_statement, chapters: n.chapters, tone: n.tone };
}
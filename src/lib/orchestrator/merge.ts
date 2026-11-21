import { NarrativePlan, Chapter, type NarrativePlanT, type ChapterT, type PlacementReasonT, type NarrativeEditT } from "../agents/schemas";
import { ApiError } from "../api/errors";
import type { UserEditDTO } from "@/types";

/**
 * 用户编辑覆盖层调和（设计文档 §5.2 / §7.3 / 提示词8）——叙事重跑后、落库前执行。
 * 从新 AI 基线起：剔除已不在 keep 集的照片 → 补回 must_keep → 按创建序回放 user_edits
 * （文本覆盖、章节/照片顺序、跨章归属、放置位置、锁定）→ 丢弃非锁定空章、补满锁定空章 →
 * 跨章去重 → 重算每章开场/结尾。锁定行同样回放，系统永不丢弃锁定章节。
 * 丢弃编辑永远需要用户显式带 scope 的动作（regenerate），不在此发生。
 */
export interface MergeContext {
  keepIds: string[];
  mustKeepIds: string[];
}

/** 发布边界的结构/引用校验，不调用 AI 文案过滤器，也不改写作者文字。 */
export function assertNarrativeStructure(plan: NarrativePlanT, ctx: MergeContext & { motifPhotoIds?: string[] }, requireMustKeep = true): void {
  const parsed = NarrativePlan.safeParse(plan);
  const fail = () => { throw new ApiError(422, "narrative_structure", "叙事结构或照片引用无效，旧作品未更改。"); };
  if (!parsed.success) fail();
  const chapters = new Set<string>();
  const photos = new Set<string>();
  const keep = new Set(ctx.keepIds);
  for (const ch of plan.chapters) {
    if (!ch.id || chapters.has(ch.id)) fail();
    chapters.add(ch.id);
    for (const id of ch.photo_ids) {
      if (!keep.has(id) || photos.has(id)) fail();
      photos.add(id);
    }
    for (const anchor of [ch.opening_photo_id, ch.closing_photo_id]) {
      if (anchor !== undefined && !ch.photo_ids.includes(anchor)) fail();
    }
    const reasons = new Set<string>();
    for (const reason of ch.placement_reasons) {
      const key = `${reason.photo_id}:${reason.role}`;
      if (!ch.photo_ids.includes(reason.photo_id) || reasons.has(key)) fail();
      reasons.add(key);
    }
  }
  // keep 是可用候选，不强迫全部入章；只有作者明确必留的照片必须出现。
  if (requireMustKeep && ctx.mustKeepIds.some((id) => !keep.has(id) || !photos.has(id))) fail();
  if (ctx.motifPhotoIds?.length && !ctx.motifPhotoIds.some((id) => photos.has(id))) fail();
}

/** merge 本身有兼容旧数据的调和行为；发布端必须先验引用，再确认编辑确实应用，不能静默丢弃。 */
export function assertNarrativeEdits(plan: NarrativePlanT, edits: NarrativeEditT[], ctx: MergeContext, applied = false): void {
  const chapters = new Map(plan.chapters.map((ch) => [ch.id, ch]));
  const membership = new Map(plan.chapters.flatMap((ch) => ch.photo_ids.map((id) => [id, ch.id] as const)));
  const keep = new Set(ctx.keepIds);
  const fail = () => { throw new ApiError(422, "narrative_edit_conflict", "编辑目标或引用已失效，旧作品未更改；请检查章节和照片后再保存。"); };
  const ids = (value: unknown): value is string[] => Array.isArray(value) && value.every((id) => typeof id === "string") && new Set(value).size === value.length;
  // 一批移动与排序按最终归属验证，避免依赖请求中两个操作的排列顺序。
  if (!applied) for (const e of edits) {
    const move = /^photo:([^.]+)\.membership$/.exec(e.target_path);
    if (move && typeof e.value === "string") membership.set(move[1], e.value);
  }
  for (const e of edits) {
    const path = e.target_path;
    const value = e.value;
    const narrativeField = /^narrative\.(title|subtitle|curatorial_statement)$/.exec(path);
    if (narrativeField) {
      const field = narrativeField[1] as "title" | "subtitle" | "curatorial_statement";
      if (!NarrativePlan.shape[field].safeParse(value).success || (applied && plan[field] !== value)) fail();
    } else if (path === "narrative.chapter_order") {
      if (!ids(value) || value.some((id) => !chapters.has(id))) fail();
      if (applied && ids(value) && value.some((id, i) => plan.chapters[i]?.id !== id)) fail();
    } else {
      const chapter = /^chapter:([^.]+)\.(title|description|locked|photo_order)$/.exec(path);
      const photo = /^photo:([^.]+)\.(membership|placement)$/.exec(path);
      if (chapter) {
        const ch = chapters.get(chapter[1]);
        if (!ch) { fail(); continue; }
        if (chapter[2] === "photo_order") {
          if (!ids(value) || value.some((id) => !keep.has(id) || membership.get(id) !== ch.id)) fail();
          if (applied && ids(value) && value.some((id, i) => ch.photo_ids[i] !== id)) fail();
        } else {
          const field = chapter[2] as "title" | "description" | "locked";
          if (!Chapter.shape[field].safeParse(value).success || (applied && ch[field] !== value)) fail();
        }
      } else if (photo) {
        const pid = photo[1];
        if (!keep.has(pid) || !membership.has(pid)) fail();
        if (photo[2] === "membership") {
          if (typeof value !== "string" || !chapters.has(value) || (applied && membership.get(pid) !== value)) fail();
        } else {
          if (!["opening", "development", "turning", "closing"].includes(String(value))) fail();
          if (applied) {
            const ch = chapters.get(membership.get(pid)!);
            if (!ch || (value === "opening" ? ch.opening_photo_id !== pid : value === "closing" ? ch.closing_photo_id !== pid : !ch.placement_reasons.some((r) => r.photo_id === pid && r.role === value))) fail();
          }
        }
      } else fail();
    }
  }
}

const clampText = (s: string, max: number) => [...s].slice(0, max).join("");
const asArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

function applyEdit(plan: NarrativePlanT, e: UserEditDTO, keep: Set<string>): void {
  const path = e.target_path;
  const v = e.value;
  if (path === "narrative.title") {
    plan.title = clampText(String(v), 60);
  } else if (path === "narrative.subtitle") {
    plan.subtitle = clampText(String(v), 80);
  } else if (path === "narrative.curatorial_statement") {
    plan.curatorial_statement = clampText(String(v), 100);
  } else if (path === "narrative.chapter_order") {
    const order = asArray(v);
    const byId = new Map(plan.chapters.map((c) => [c.id, c]));
    const reordered = order.map((id) => byId.get(id)).filter((c): c is ChapterT => !!c);
    for (const c of plan.chapters) if (!order.includes(c.id)) reordered.push(c);
    plan.chapters = reordered;
  } else if (path.startsWith("chapter:")) {
    const [cid, field] = path.slice("chapter:".length).split(".");
    const c = plan.chapters.find((x) => x.id === cid);
    if (!c) return;
    if (field === "title") c.title = clampText(String(v), 60);
    else if (field === "description") c.description = clampText(String(v), 100);
    else if (field === "locked") c.locked = !!v;
    else if (field === "photo_order") {
      const desired = asArray(v).filter((id) => c.photo_ids.includes(id));
      for (const id of c.photo_ids) if (!desired.includes(id)) desired.push(id);
      c.photo_ids = desired;
    }
  } else if (path.startsWith("photo:")) {
    const [pid, field] = path.slice("photo:".length).split(".");
    if (!keep.has(pid)) return;
    if (field === "membership") {
      const target = plan.chapters.find((x) => x.id === String(v));
      if (!target) return;
      for (const c of plan.chapters) c.photo_ids = c.photo_ids.filter((id) => id !== pid);
      if (!target.photo_ids.includes(pid)) target.photo_ids.push(pid);
    } else if (field === "placement") {
      const role = String(v);
      const c = plan.chapters.find((x) => x.photo_ids.includes(pid));
      if (!c) return;
      if (role === "opening" || role === "closing") {
        c.photo_ids = c.photo_ids.filter((id) => id !== pid);
        if (role === "opening") c.photo_ids.unshift(pid);
        else c.photo_ids.push(pid);
      } else {
        c.placement_reasons = c.placement_reasons.filter((r) => r.photo_id !== pid);
        c.placement_reasons.push({ photo_id: pid, role: role as PlacementReasonT["role"], reason: "用户指定的放置位置。" });
      }
    }
  }
}

/** 丢弃非锁定空章；锁定空章从最大捐赠章补入一张（捐赠章可能因此变空，再丢弃非锁定者）。 */
function reconcile(plan: NarrativePlanT): void {
  plan.chapters = plan.chapters.filter((c) => c.photo_ids.length > 0 || c.locked);
  for (const c of plan.chapters) {
    if (c.photo_ids.length > 0) continue;
    const donor = plan.chapters
      .filter((o) => o !== c && o.photo_ids.length > 0)
      .sort((a, b) => b.photo_ids.length - a.photo_ids.length)[0];
    if (donor) c.photo_ids.push(donor.photo_ids.pop()!);
  }
  plan.chapters = plan.chapters.filter((c) => c.photo_ids.length > 0 || c.locked);
}

function dedupe(plan: NarrativePlanT): void {
  const seen = new Set<string>();
  for (const c of plan.chapters) {
    c.photo_ids = c.photo_ids.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
  }
}

function ensureTwoChapters(plan: NarrativePlanT): void {
  if (plan.chapters.length >= 2) return;
  const source = plan.chapters[0];
  const all = plan.chapters.flatMap((c) => c.photo_ids);
  if (all.length < 2) return;
  const mid = Math.ceil(all.length / 2);
  plan.chapters = [
    { id: "chapter_01", title: source?.title ?? "进入", description: source?.description ?? "空间先出现。", photo_ids: all.slice(0, mid), placement_reasons: [], locked: source?.locked ?? false },
    { id: "chapter_02", title: "留下", description: "观看在安静处收束。", photo_ids: all.slice(mid), placement_reasons: [], locked: false },
  ];
}

export function mergeNarrative(base: NarrativePlanT, edits: UserEditDTO[], ctx: MergeContext): NarrativePlanT {
  const keep = new Set(ctx.keepIds);
  const plan = structuredClone(base);

  for (const c of plan.chapters) {
    c.photo_ids = c.photo_ids.filter((id) => keep.has(id));
    c.placement_reasons = c.placement_reasons.filter((r) => keep.has(r.photo_id));
  }

  const present = new Set(plan.chapters.flatMap((c) => c.photo_ids));
  const last = plan.chapters[plan.chapters.length - 1];
  for (const id of ctx.mustKeepIds) {
    if (keep.has(id) && !present.has(id) && last) {
      last.photo_ids.push(id);
      present.add(id);
    }
  }

  const sorted = [...edits].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  for (const e of sorted) applyEdit(plan, e, keep);

  reconcile(plan);
  dedupe(plan);
  reconcile(plan);
  ensureTwoChapters(plan);

  for (const c of plan.chapters) {
    c.photo_ids = [...new Set(c.photo_ids)];
    c.placement_reasons = c.placement_reasons.filter((r) => c.photo_ids.includes(r.photo_id));
    c.opening_photo_id = c.photo_ids[0];
    c.closing_photo_id = c.photo_ids[c.photo_ids.length - 1];
  }

  return plan;
}

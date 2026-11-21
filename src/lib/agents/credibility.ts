import type { NarrativePlanT } from "./schemas";

/**
 * 文案可信边界校验器（§13.3 六条 / 提示词5 / §17.3）。叙事与质检共用。
 * 把"不可编造"变成可编程的确定性守卫：禁断言关键词 + 无保留表达的内心推测 + 字数 + 结构完整性。
 * 只校验 AI 输出（落库前）；用户编辑拥有最终审美决定权，不在此被否决。
 */
export type CredibilityRule =
  | "forbidden_assertion"
  | "unhedged_speculation"
  | "paragraph_too_long"
  | "empty_chapter"
  | "duplicate_photo"
  | "photo_not_kept"
  | "motif_no_evidence";

export interface CredibilityViolation {
  rule: CredibilityRule;
  message: string;
  path: string;
  photo_ids?: string[];
}

export interface CredibilityReport {
  ok: boolean;
  violations: CredibilityViolation[];
}

export interface CredibilityContext {
  /** effective ∈ {keep, must_keep} 的照片 id 集。 */
  keepIds: string[];
  /** 所选主题的证据照片 id（用于断言主题在叙事中确有证据）。 */
  motifPhotoIds?: string[];
}

/** §13.3.3/.4/.5：私人关系、临床心理诊断、编造的具体事件——任何语气下都不得作为事实写出。 */
const FORBIDDEN =
  /分手|恋人|情侣|夫妻|爱人|前任|男友|女友|亲人|家人|妻子|丈夫|抑郁|焦虑症|创伤|心理疾病|绝望|婚礼|葬礼|争吵|毕业典礼/;

/** 内心状态/经历动词：出现即属推测，必须配保留表达，否则违反§13.3.1。 */
const INNER_STATE = /感到|觉得|内心|心想|思念|渴望|害怕|回忆/;
/** 提示词5.3 保留表达。 */
const HEDGE = /像是|似乎|可以被看作|仿佛|也许|可能|或许|好像/;

export function isCredibleText(text: string): boolean {
  return !FORBIDDEN.test(text) && (!INNER_STATE.test(text) || HEDGE.test(text));
}

const MAX_PARAGRAPH = 100;
const charLen = (s: string) => [...s].length;

interface TextField {
  path: string;
  text: string;
  paragraph: boolean;
}

function textFields(plan: NarrativePlanT): TextField[] {
  const out: TextField[] = [
    { path: "narrative.title", text: plan.title, paragraph: false },
    { path: "narrative.subtitle", text: plan.subtitle, paragraph: false },
    { path: "narrative.curatorial_statement", text: plan.curatorial_statement, paragraph: true },
  ];
  for (const c of plan.chapters) {
    out.push({ path: `chapter:${c.id}.title`, text: c.title, paragraph: false });
    out.push({ path: `chapter:${c.id}.description`, text: c.description, paragraph: true });
    for (const pr of c.placement_reasons) {
      out.push({ path: `chapter:${c.id}.placement_reasons`, text: pr.reason, paragraph: true });
    }
  }
  return out;
}

export function checkNarrativeCredibility(plan: NarrativePlanT, ctx: CredibilityContext): CredibilityReport {
  const violations: CredibilityViolation[] = [];
  const keep = new Set(ctx.keepIds);

  for (const f of textFields(plan)) {
    if (FORBIDDEN.test(f.text)) {
      violations.push({
        rule: "forbidden_assertion",
        message: "文案包含私人关系、心理诊断或编造事件的断言，超出可观察事实边界。",
        path: f.path,
      });
    }
    if (INNER_STATE.test(f.text) && !HEDGE.test(f.text)) {
      violations.push({
        rule: "unhedged_speculation",
        message: "对内心状态的推测未使用「像是/似乎/可以被看作」等保留表达，不能写成事实。",
        path: f.path,
      });
    }
    if (f.paragraph && charLen(f.text) > MAX_PARAGRAPH) {
      violations.push({
        rule: "paragraph_too_long",
        message: `段落超过 ${MAX_PARAGRAPH} 个中文字符（当前 ${charLen(f.text)}）。`,
        path: f.path,
      });
    }
  }

  const seen = new Map<string, number>();
  const notKept = new Set<string>();
  const narrativePhotos = new Set<string>();
  for (const c of plan.chapters) {
    if (c.photo_ids.length === 0) {
      violations.push({ rule: "empty_chapter", message: `章节「${c.title}」没有照片。`, path: `chapter:${c.id}` });
    }
    for (const pid of c.photo_ids) {
      narrativePhotos.add(pid);
      seen.set(pid, (seen.get(pid) ?? 0) + 1);
      if (!keep.has(pid)) notKept.add(pid);
    }
  }

  const dups = [...seen.entries()].filter(([, n]) => n > 1).map(([pid]) => pid);
  if (dups.length > 0) {
    violations.push({
      rule: "duplicate_photo",
      message: "同一张照片出现在多个章节，除非用户主动允许，否则不应跨章重复。",
      path: "narrative.chapters",
      photo_ids: dups,
    });
  }
  if (notKept.size > 0) {
    violations.push({
      rule: "photo_not_kept",
      message: "章节引用了不在保留集（keep/must_keep）中的照片。",
      path: "narrative.chapters",
      photo_ids: [...notKept],
    });
  }

  if (ctx.motifPhotoIds && ctx.motifPhotoIds.length > 0) {
    const hasEvidence = ctx.motifPhotoIds.some((pid) => narrativePhotos.has(pid));
    if (!hasEvidence) {
      violations.push({
        rule: "motif_no_evidence",
        message: "所选主题的证据照片未出现在叙事中，主题缺乏可见支撑。",
        path: "narrative.selected_motif_id",
        photo_ids: ctx.motifPhotoIds,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}
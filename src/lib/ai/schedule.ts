/**
 * DeepSeek 空闲时段调度（作者约束）：北京时间周一至周五（不含中国法定节假日）
 * 9:00–12:00、14:00–18:00 为高峰禁止真实 AI 体验启动；其余时段可用。
 * 节假日由 env AI_PEAK_HOLIDAYS 日期列表维护（逗号分隔 YYYY-MM-DD），未维护按普通工作日保守处理。
 * 仅拦截「新 AI 体验启动」；已开始影展内的重试放行。
 */

export interface AiWindow {
  allowed: boolean;
  /** 用户可读的一句话说明（普通用户文案） */
  message: string;
  /** 高峰时给出预计恢复时刻（HH:mm，北京时间），可为空 */
  resumeHint: string | null;
}

const PEAK_WINDOWS: Array<[number, number]> = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
];

/** 大赛评审期全天候开放窗口：env AI_REVIEW_WINDOW="2026-12-01~2026-12-07"（北京日期闭区间）。 */
function reviewPeriod(now: Date): { active: boolean; start: string; end: string } {
  const raw = (process.env.AI_REVIEW_WINDOW ?? "").trim();
  const m = /^(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})$/.exec(raw);
  if (!m) return { active: false, start: m?.[1] ?? "", end: m?.[2] ?? "" };
  const day = new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  return { active: day >= m[1] && day <= m[2], start: m[1], end: m[2] };
}

function beijingParts(now: Date): { day: number; minutes: number; dateKey: string } {
  // 用 en-CA 得到 YYYY-MM-DD，再取星期；统一按北京时间（UTC+8，无夏令时）偏移。
  const shifted = new Date(now.getTime() + 8 * 3600_000);
  const dateKey = shifted.toISOString().slice(0, 10);
  const hh = Number(shifted.toISOString().slice(11, 13));
  const mm = Number(shifted.toISOString().slice(14, 16));
  // getUTCDay 用 shifted（已偏移）的星期
  const day = shifted.getUTCDay();
  return { day, minutes: hh * 60 + mm, dateKey };
}

function holidaySet(): Set<string> {
  const raw = process.env.AI_PEAK_HOLIDAYS ?? "";
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

function isPeak(parts: { day: number; minutes: number; dateKey: string }, holidays: Set<string>): boolean {
  if (holidays.has(parts.dateKey)) return false; // 法定节假日全天空闲
  if (parts.day === 0 || parts.day === 6) return false; // 周末全天空闲
  return PEAK_WINDOWS.some(([from, to]) => parts.minutes >= from && parts.minutes < to);
}

function nextResume(minutes: number): string | null {
  // 阻塞时必然处于某个高峰窗口内 → 恢复时刻 = 当前窗口的结束时刻（北京时间）
  const current = PEAK_WINDOWS.find(([from, to]) => minutes >= from && minutes < to);
  if (!current) return null;
  const hh = String(Math.floor(current[1] / 60)).padStart(2, "0");
  const mm = String(current[1] % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function aiWindowNow(now = new Date()): AiWindow {
  const parts = beijingParts(now);
  const holidays = holidaySet();
  // 大赛评审期：真实 AI 全天候开放（额度约束仍生效，由额度层负责）。
  const review = reviewPeriod(now);
  if (review.active) {
    return {
      allowed: true,
      message: `大赛评审期（${review.start} 至 ${review.end}）：真实 AI 策展全天候开放，每日体验名额仍然有限。`,
      resumeHint: null,
    };
  }
  if (!isPeak(parts, holidays)) {
    return { allowed: true, message: "当前为 DeepSeek 空闲时段，可体验真实 AI 策展。", resumeHint: null };
  }
  const resume = nextResume(parts.minutes);
  const holidayNote = holidays.size === 0 ? "" : "（法定节假日与周末全天可用）";
  return {
    allowed: false,
    message: `当前为 DeepSeek 高峰时段（工作日 9:00–12:00、14:00–18:00），真实 AI 策展体验暂不可用，请在空闲时段使用${holidayNote}。`,
    resumeHint: resume ? `预计北京时间 ${resume} 恢复` : "今日高峰结束后恢复",
  };
}

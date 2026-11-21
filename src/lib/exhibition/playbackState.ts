import type { PlaybackSpeedId } from "./playbackPlan";

/**
 * 放映状态机（§19.8）：idle→preparing→playing↔paused→ended，纯 reducer。
 * pause_reason 区分手动/系统暂停；image_ready 只续播图片等待，
 * 手动/后台/打印暂停绝不自动恢复。引擎（DOM/rAF）与导出脚本遵循同一语义。
 */

export type PlaybackPhase = "idle" | "preparing" | "playing" | "paused" | "ended";

export type PauseReason =
  | "manual"
  | "hidden_tab"
  | "image_loading"
  | "print"
  | "reduced_motion"
  | "layout_changed";

export interface PlaybackState {
  phase: PlaybackPhase;
  /** 展示用主暂停原因（按优先级取 pauseReasons 最高者）。 */
  pauseReason: PauseReason | null;
  /** 全部未解除的暂停原因；image_ready 只移除 image_loading，其余原因继续压住续播。 */
  pauseReasons: PauseReason[];
  /** 当前停靠点（展开后的索引，由引擎钳制）。 */
  stopIndex: number;
  speed: PlaybackSpeedId;
  notice: string | null;
}

export type PlaybackAction =
  | { type: "prepare" }
  | { type: "ready" }
  | { type: "pause"; reason: PauseReason }
  | { type: "resume" }
  | { type: "end" }
  | { type: "restart" }
  | { type: "stop" }
  | { type: "goto"; stopIndex: number }
  | { type: "set_speed"; speed: PlaybackSpeedId }
  | { type: "layout_changed" }
  | { type: "image_wait" }
  | { type: "image_ready" }
  | { type: "notice"; text: string | null };

export const initialPlaybackState: PlaybackState = {
  phase: "idle",
  pauseReason: null,
  pauseReasons: [],
  stopIndex: 0,
  speed: "standard",
  notice: null,
};

/** 展示优先级：用户手动 > 布局变化 > 后台/打印/减少动态 > 图片等待。 */
const REASON_PRIORITY: PauseReason[] = [
  "manual",
  "layout_changed",
  "hidden_tab",
  "print",
  "reduced_motion",
  "image_loading",
];

function reasonsOf(state: PlaybackState): PauseReason[] {
  const reasons = state.pauseReasons ?? [];
  // 兼容仅带 pauseReason 的历史状态：主原因不能被后来的系统暂停挤掉
  return state.pauseReason && !reasons.includes(state.pauseReason) ? [state.pauseReason, ...reasons] : reasons;
}

function primaryReason(reasons: PauseReason[]): PauseReason | null {
  for (const r of REASON_PRIORITY) if (reasons.includes(r)) return r;
  return reasons[0] ?? null;
}

function pausedWith(state: PlaybackState, reasons: PauseReason[]): PlaybackState {
  return { ...state, phase: "paused", pauseReasons: reasons, pauseReason: primaryReason(reasons) };
}

function withReason(state: PlaybackState, reason: PauseReason): PauseReason[] {
  const reasons = reasonsOf(state);
  return reasons.includes(reason) ? reasons : [...reasons, reason];
}

export function playbackReducer(state: PlaybackState, action: PlaybackAction): PlaybackState {
  switch (action.type) {
    case "prepare":
    case "restart":
      return { ...state, phase: "preparing", pauseReason: null, pauseReasons: [], stopIndex: 0, notice: null };
    case "ready":
      return state.phase === "preparing" ? { ...state, phase: "playing" } : state;
    case "pause":
      // 暂停中也接受新原因：图片等待期间到来的手动/后台/打印暂停不能被丢弃
      if (state.phase !== "playing" && state.phase !== "preparing" && state.phase !== "paused") return state;
      return pausedWith(state, withReason(state, action.reason));
    case "resume":
      // 用户显式继续：解除全部暂停原因
      return state.phase === "paused"
        ? { ...state, phase: "playing", pauseReason: null, pauseReasons: [], notice: null }
        : state;
    case "end":
      return state.phase === "playing" ? { ...state, phase: "ended", pauseReason: null, pauseReasons: [] } : state;
    case "stop":
      return { ...state, phase: "idle", pauseReason: null, pauseReasons: [], stopIndex: 0, notice: null };
    case "goto":
      // 上一段/下一段/章节导航默认进入暂停，方便观看
      return { ...state, phase: "paused", pauseReason: "manual", pauseReasons: ["manual"], stopIndex: action.stopIndex };
    case "set_speed":
      return { ...state, speed: action.speed };
    case "layout_changed": {
      if (state.phase === "idle" || state.phase === "ended") return state;
      // 旧几何上的图片等待已被引擎作废，不再压住新的布局提示
      const base: PauseReason[] = reasonsOf(state).filter((r) => r !== "image_loading");
      const reasons: PauseReason[] = base.includes("layout_changed") ? base : [...base, "layout_changed"];
      return { ...pausedWith(state, reasons), notice: "布局已更新，放映已暂停。可从头播放新版本。" };
    }
    case "image_wait":
      if (state.phase !== "playing" && state.phase !== "paused") return state;
      return pausedWith(state, withReason(state, "image_loading"));
    case "image_ready": {
      // 只解除图片等待；手动/后台/打印/布局暂停仍在则保持暂停
      const reasons = reasonsOf(state);
      if (state.phase !== "paused" || !reasons.includes("image_loading")) return state;
      const remaining = reasons.filter((r) => r !== "image_loading");
      return remaining.length === 0
        ? { ...state, phase: "playing", pauseReason: null, pauseReasons: [] }
        : pausedWith(state, remaining);
    }
    case "notice":
      return { ...state, notice: action.text };
    default:
      return state;
  }
}
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PLAYBACK_SPEEDS } from "@/lib/exhibition/playbackPlan";
import type { PlaybackApi } from "./useExhibitionPlayback";

/**
 * 放映控制条（§19.8）：开始/暂停/继续、上一段/下一段、从头播放、速度（舒缓/标准/快速）、
 * 当前章节与路线进度、全屏、返回手动浏览。中文标签、≥44px 触控区；
 * 播放时适度淡出，交互即恢复，主播放/暂停按钮始终可发现。
 */

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} 分 ${s % 60} 秒` : `${s} 秒`;
}

const BTN = "inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-md px-3 text-sm transition-colors";

export function PlaybackControls({
  api,
  exhibitionId,
  embed = false,
  author = true,
}: {
  api: PlaybackApi;
  exhibitionId: string;
  embed?: boolean;
  author?: boolean;
}) {
  const { state } = api;
  const [idle, setIdle] = useState(false);

  // 播放中 3 秒无交互淡出；鼠标/触摸/键盘即恢复（暂停按钮不参与淡出）。
  // idle 只在计时器回调（异步）里置位，避免 effect 内同步 setState。
  useEffect(() => {
    if (state.phase !== "playing") return;
    let timer = window.setTimeout(() => setIdle(true), 3000);
    const reset = window.setTimeout(() => setIdle(false), 0);
    const wake = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), 3000);
    };
    window.addEventListener("pointermove", wake);
    window.addEventListener("touchstart", wake);
    window.addEventListener("keydown", wake);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(reset);
      window.removeEventListener("pointermove", wake);
      window.removeEventListener("touchstart", wake);
      window.removeEventListener("keydown", wake);
    };
  }, [state.phase]);
  const faded = state.phase === "playing" && idle;

  if (!api.hasRoute) return null;

  const primaryLabel =
    state.phase === "playing" ? "暂停" : state.phase === "paused" ? "继续" : state.phase === "preparing" ? "准备中…" : "开始放映";
  const chapterText = api.currentChapterTitle ? `${api.currentChapterTitle} · ${api.currentLabel}` : api.currentLabel;

  return (
    <div className={`playback-bar fixed inset-x-0 bottom-0 z-40 ${faded ? "playback-faded" : ""}`}>
      {state.notice && (
        <p role="status" className="playback-notice mx-auto mb-2 max-w-xl rounded-md border border-gold/40 bg-ink/95 px-4 py-2 text-center text-xs text-gold">
          {state.notice}
        </p>
      )}

      {state.phase === "ended" ? (
        <div className="playback-end mx-auto max-w-xl rounded-t-lg border border-b-0 border-ink-line bg-ink/95 px-5 py-4 text-center backdrop-blur">
          <p className="font-display text-base text-text">放映结束。你可以重新观看，或回到作品继续调整。</p>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <button className={`${BTN} btn-primary playback-primary`} onClick={api.restart}>重新放映</button>
            <button className={`${BTN} btn-outline`} onClick={api.exit}>手动浏览</button>
            {!embed && (
              <Link href="/" className={`${BTN} btn-ghost`}>返回首页</Link>
            )}
            {author && !embed && (
              <Link href={`/e/${exhibitionId}/layout`} className={`${BTN} btn-outline`}>返回编辑</Link>
            )}
          </div>
        </div>
      ) : (
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-2 gap-y-1 rounded-t-lg border border-b-0 border-ink-line bg-ink/95 px-3 py-2 backdrop-blur">
          <button
            className={`${BTN} btn-primary playback-primary font-medium`}
            onClick={api.toggle}
            disabled={state.phase === "preparing"}
            aria-label={primaryLabel}
          >
            {state.phase === "playing" ? "❚❚ " : "▶ "}
            {primaryLabel}
          </button>
          <button className={`${BTN} btn-outline`} onClick={api.prev} aria-label="上一段">← 上一段</button>
          <button className={`${BTN} btn-outline`} onClick={api.next} aria-label="下一段">下一段 →</button>
          <button className={`${BTN} btn-ghost`} onClick={api.restart} aria-label="从头播放">⟲ 从头播放</button>

          <label className="inline-flex min-h-11 items-center gap-1 text-xs text-muted">
            速度
            <select
              className="field !w-auto !py-1.5 text-xs"
              value={state.speed}
              onChange={(e) => api.setSpeed(e.target.value as (typeof PLAYBACK_SPEEDS)[number]["id"])}
              aria-label="放映速度"
            >
              {PLAYBACK_SPEEDS.map((s) => (
                <option key={s.id} value={s.id}>{s.label} {s.factor}×</option>
              ))}
            </select>
          </label>

          <button className={`${BTN} btn-ghost`} onClick={api.fullscreen} aria-label={api.isFullscreen ? "退出全屏" : "全屏放映"}>
            {api.isFullscreen ? "退出全屏" : "全屏"}
          </button>
          {state.phase !== "idle" && (
            <button className={`${BTN} btn-ghost`} onClick={api.exit} aria-label="返回手动浏览">手动浏览</button>
          )}

          <div className="order-last w-full min-w-0 flex-1 basis-full sm:order-none sm:basis-40">
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-ink-line"
              role="progressbar"
              aria-label="放映进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(api.progress * 100)}
            >
              <div className="h-full rounded-full bg-gold transition-[width] duration-150" style={{ width: `${api.progress * 100}%` }} />
            </div>
            <p className="mt-1 truncate text-[11px] text-muted">
              {api.waitingImage
                ? "正在等待图片加载…"
                : state.phase === "idle"
                  ? "点「开始放映」自动滚动浏览，随时可用滚轮接管。"
                  : `${chapterText || "影展"} · 预计约 ${fmtDuration(api.estimatedTotalMs)}`}
              {state.phase === "paused" && state.pauseReason === "hidden_tab" && " · 已暂停"}
            </p>
          </div>

          {!embed && (
            <span className="hidden text-[10px] text-muted lg:inline">Space 播放/暂停 · ←→ 翻段 · F 全屏</span>
          )}
        </div>
      )}
    </div>
  );
}
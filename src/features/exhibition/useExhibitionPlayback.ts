"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import {
  PLAYBACK_SPEEDS,
  PLAYBACK_TRANSITION_MS,
  estimateTotalMs,
  type PlaybackRoute,
} from "@/lib/exhibition/playbackPlan";
import {
  computeProgress,
  expandRoute,
  nearestExpandedIndex,
  type ExpandedStop,
} from "@/lib/exhibition/playbackGeometry";
import {
  initialPlaybackState,
  playbackReducer,
  type PlaybackState,
} from "@/lib/exhibition/playbackState";

/**
 * 放映引擎（§19.8/§19.9）：rAF + 实际 elapsed + 浮点累计位置驱动自动滚动。
 * 状态语义全部来自纯 playbackReducer；本 hook 只负责 DOM 测量、计时、
 * 接管识别、图片等待/预加载、可见性/打印/减少动态效果策略与清理。
 * embed iframe 内同样适用——window 即 iframe 自身，绝不滚动父页。
 */

const IMAGE_WAIT_TIMEOUT_MS = 8000;
const NAV_OFFSET = 56;
const EASE = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

interface Pos {
  index: number;
  elapsed: number;
  mode: "dwell" | "transition";
  fromY: number;
  toY: number;
  transElapsed: number;
}

export interface PlaybackApi {
  state: PlaybackState;
  progress: number;
  currentChapterTitle: string | null;
  currentLabel: string;
  estimatedTotalMs: number;
  waitingImage: boolean;
  reducedMotion: boolean;
  isFullscreen: boolean;
  hasRoute: boolean;
  start: () => void;
  pause: () => void;
  resume: () => void;
  toggle: () => void;
  prev: () => void;
  next: () => void;
  restart: () => void;
  exit: () => void;
  setSpeed: (speed: (typeof PLAYBACK_SPEEDS)[number]["id"]) => void;
  gotoChapter: (chapterId: string) => void;
  fullscreen: () => void;
}

export function useExhibitionPlayback({
  exhibitionId,
  route,
  layoutVersion,
  ready,
  autoStart,
  embed,
}: {
  exhibitionId: string;
  route: PlaybackRoute | null;
  layoutVersion: string | null;
  ready: boolean;
  autoStart: boolean;
  embed: boolean;
}): PlaybackApi {
  const [state, dispatch] = useReducer(playbackReducer, initialPlaybackState);
  const [snapshot, setSnapshot] = useState<
    { progress: number; index: number; chapterTitle: string | null; label: string }
  >({ progress: 0, index: 0, chapterTitle: null, label: "" });
  const [isFullscreen, setIsFullscreen] = useState(false);

  const stateRef = useRef(state);
  const routeRef = useRef(route);
  // 在提交后同步最新值给 rAF/事件回调（渲染期间不写 ref）。
  useEffect(() => {
    stateRef.current = state;
    routeRef.current = route;
  });

  const expandedRef = useRef<ExpandedStop[]>([]);
  const posRef = useRef<Pos>({ index: 0, elapsed: 0, mode: "dwell", fromY: 0, toY: 0, transElapsed: 0 });
  const lastTsRef = useRef<number | null>(null);
  const programmaticRef = useRef<{ y: number; until: number }>({ y: 0, until: 0 });
  const preloadedRef = useRef<Set<string>>(new Set());
  const imageWaitCleanupRef = useRef<(() => void) | null>(null);
  const consumedIntentRef = useRef(false);
  const lastVersionRef = useRef<string | null>(null);
  const lastSnapshotRef = useRef(0);
  // 播放周期令牌：停止/重播/布局更换后，旧的图片加载回调一律作废
  const cycleRef = useRef(0);

  const speedFactor = useCallback(
    (s: PlaybackState["speed"]) => PLAYBACK_SPEEDS.find((x) => x.id === s)?.factor ?? 1,
    [],
  );

  const measure = useCallback(() => {
    const r = routeRef.current;
    if (!r) return;
    const measures: Record<string, { top: number; height: number }> = {};
    const y = window.scrollY;
    for (const stop of r.stops) {
      const el = document.getElementById(stop.sectionId);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      measures[stop.sectionId] = { top: rect.top + y, height: rect.height };
    }
    const viewportH = window.innerHeight;
    const maxScrollY = Math.max(0, document.documentElement.scrollHeight - viewportH);
    expandedRef.current = expandRoute(r, measures, {
      viewportH,
      navOffset: embed ? 8 : NAV_OFFSET,
      maxScrollY,
    });
  }, [embed]);

  const scrollToProgrammatic = useCallback((y: number) => {
    programmaticRef.current = { y, until: performance.now() + 200 };
    // behavior:"instant" 避开全局 scroll-behavior:smooth，防止每帧开启新平滑滚动
    window.scrollTo({ top: y, behavior: "instant" });
  }, []);

  const preloadAround = useCallback(
    (index: number) => {
      const exp = expandedRef.current;
      const r = routeRef.current;
      if (!r) return;
      for (const i of [index, index + 1]) {
        const e = exp[i];
        if (!e) continue;
        const variant = r.stops[e.stopIndex].type === "image_group" ? "thumb" : "original";
        for (const pid of e.photoIds) {
          const src = `/api/files/${exhibitionId}/${pid}?variant=${variant}`;
          if (preloadedRef.current.has(src)) continue;
          preloadedRef.current.add(src);
          const img = new Image();
          img.src = src;
        }
      }
    },
    [exhibitionId],
  );

  /** 图片未就绪→暂停时间推进；加载/失败/超时后继续（失败有胶片占位，不无限卡住）。 */
  const waitForImages = useCallback((index: number, onReady: () => void) => {
    imageWaitCleanupRef.current?.();
    imageWaitCleanupRef.current = null;
    const e = expandedRef.current[index];
    const el = e ? document.getElementById(e.sectionId) : null;
    const imgs = el ? Array.from(el.querySelectorAll("img")) : [];
    const pending = imgs.filter((i) => !i.complete);
    if (pending.length === 0) {
      onReady();
      return;
    }
    dispatch({ type: "image_wait" });
    const cycle = cycleRef.current;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      // 过期周期（已停止/重播/换布局）不解除当前暂停
      if (cycle !== cycleRef.current) return;
      onReady();
    };
    const check = () => {
      if (pending.every((i) => i.complete)) finish();
    };
    const timer = window.setTimeout(finish, IMAGE_WAIT_TIMEOUT_MS);
    const cleanup = () => {
      window.clearTimeout(timer);
      pending.forEach((i) => {
        i.removeEventListener("load", check);
        i.removeEventListener("error", check);
      });
      imageWaitCleanupRef.current = null;
    };
    pending.forEach((i) => {
      i.addEventListener("load", check);
      i.addEventListener("error", check);
    });
    imageWaitCleanupRef.current = cleanup;
  }, []);

  const publishSnapshot = useCallback((force = false) => {
    const now = performance.now();
    if (!force && now - lastSnapshotRef.current < 120) return;
    lastSnapshotRef.current = now;
    const pos = posRef.current;
    const exp = expandedRef.current;
    const elapsed = pos.mode === "dwell" ? pos.elapsed : 0;
    const stop = exp[pos.index] ? routeRef.current?.stops[exp[pos.index].stopIndex] : null;
    setSnapshot({
      progress: computeProgress(exp, pos.index, elapsed),
      index: pos.index,
      chapterTitle: stop?.chapterTitle ?? null,
      label: stop?.label ?? "",
    });
  }, []);

  const tick = useCallback(
    (ts: number) => {
      const st = stateRef.current;
      if (st.phase !== "playing") {
        lastTsRef.current = null;
        return;
      }
      // 后台恢复后重置时间基准，不因累计大 dt 一次跳尾
      if (lastTsRef.current === null) {
        lastTsRef.current = ts;
        return;
      }
      const dt = Math.min(ts - lastTsRef.current, 100);
      lastTsRef.current = ts;
      const exp = expandedRef.current;
      const pos = posRef.current;
      if (exp.length === 0) {
        dispatch({ type: "end" });
        return;
      }
      const factor = speedFactor(st.speed);
      const cur = exp[pos.index];
      const instant = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      if (pos.mode === "transition") {
        pos.transElapsed += dt;
        const dur = instant ? 0 : PLAYBACK_TRANSITION_MS / factor;
        const t = dur <= 0 ? 1 : Math.min(1, pos.transElapsed / dur);
        const y = pos.fromY + (pos.toY - pos.fromY) * EASE(t);
        scrollToProgrammatic(y);
        if (t >= 1) {
          pos.mode = "dwell";
          pos.elapsed = 0;
          waitForImages(pos.index, () => dispatch({ type: "image_ready" }));
        }
      } else {
        pos.elapsed += dt;
        if (pos.elapsed >= cur.dwellMs / factor) {
          if (pos.index >= exp.length - 1) {
            dispatch({ type: "end" });
            publishSnapshot(true);
            return;
          }
          pos.index += 1;
          pos.mode = "transition";
          pos.fromY = window.scrollY;
          pos.toY = exp[pos.index].targetY;
          pos.transElapsed = 0;
          preloadAround(pos.index);
        }
      }
      publishSnapshot();
    },
    [preloadAround, publishSnapshot, scrollToProgrammatic, speedFactor, waitForImages],
  );

  /** 从某个停靠点开始（准备→等首图→播放）。 */
  const beginAt = useCallback(
    (index: number) => {
      cycleRef.current += 1;
      measure();
      const exp = expandedRef.current;
      if (exp.length === 0) {
        dispatch({ type: "end" });
        return;
      }
      const i = Math.min(Math.max(0, index), exp.length - 1);
      posRef.current = { index: i, elapsed: 0, mode: "dwell", fromY: 0, toY: 0, transElapsed: 0 };
      scrollToProgrammatic(exp[i].targetY);
      preloadAround(i);
      publishSnapshot(true);
      waitForImages(i, () => dispatch({ type: "ready" }));
    },
    [measure, preloadAround, publishSnapshot, scrollToProgrammatic, waitForImages],
  );

  const start = useCallback(() => {
    dispatch({ type: "prepare" });
    beginAt(0);
  }, [beginAt]);

  const restart = useCallback(() => {
    dispatch({ type: "restart" });
    beginAt(0);
  }, [beginAt]);

  const pause = useCallback(() => dispatch({ type: "pause", reason: "manual" }), []);
  const resume = useCallback(() => {
    // 手动接管/暂停期间可能已滚动或布局已变：按最新几何与当前 scrollY 重新停靠
    measure();
    const exp = expandedRef.current;
    posRef.current = {
      index: nearestExpandedIndex(exp, window.scrollY),
      elapsed: 0,
      mode: "dwell",
      fromY: 0,
      toY: 0,
      transElapsed: 0,
    };
    lastTsRef.current = null;
    publishSnapshot(true);
    dispatch({ type: "resume" });
  }, [measure, publishSnapshot]);

  const toggle = useCallback(() => {
    const phase = stateRef.current.phase;
    if (phase === "playing") pause();
    else if (phase === "paused") resume();
    else if (phase === "ended") restart();
    else start();
  }, [pause, restart, resume, start]);

  const jumpTo = useCallback(
    (index: number) => {
      measure();
      const exp = expandedRef.current;
      if (exp.length === 0) return;
      const i = Math.min(Math.max(0, index), exp.length - 1);
      dispatch({ type: "goto", stopIndex: i });
      posRef.current = { index: i, elapsed: 0, mode: "dwell", fromY: 0, toY: 0, transElapsed: 0 };
      scrollToProgrammatic(exp[i].targetY);
      preloadAround(i);
      publishSnapshot(true);
    },
    [measure, preloadAround, publishSnapshot, scrollToProgrammatic],
  );

  const prev = useCallback(() => jumpTo(posRef.current.index - 1), [jumpTo]);
  const next = useCallback(() => jumpTo(posRef.current.index + 1), [jumpTo]);

  const exit = useCallback(() => {
    cycleRef.current += 1;
    dispatch({ type: "stop" });
    imageWaitCleanupRef.current?.();
  }, []);

  const setSpeed = useCallback((speed: PlaybackState["speed"]) => dispatch({ type: "set_speed", speed }), []);

  const gotoChapter = useCallback(
    (chapterId: string) => {
      const r = routeRef.current;
      if (!r) return;
      const stopIndex = r.stops.findIndex((s) => s.chapterId === chapterId);
      if (stopIndex < 0) return;
      const exp = expandedRef.current;
      const idx = exp.findIndex((e) => e.stopIndex === stopIndex);
      jumpTo(idx >= 0 ? idx : 0);
    },
    [jumpTo],
  );

  const fullscreen = useCallback(() => {
    // 必须在用户点击事件内申请；被拒时页内播放并提示
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    const el = document.documentElement;
    if (!el.requestFullscreen) {
      dispatch({ type: "notice", text: "此浏览器不支持全屏，已在页内放映。" });
      return;
    }
    el.requestFullscreen().catch(() => {
      dispatch({ type: "notice", text: "浏览器未允许全屏，已在页内放映。" });
    });
  }, []);

  // 减少动态效果偏好：值走 useSyncExternalStore（避免 effect 内同步 setState）
  const reducedMotion = useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => {
      if (mq.matches && ["playing", "preparing", "paused"].includes(stateRef.current.phase)) {
        dispatch({ type: "pause", reason: "reduced_motion" });
        dispatch({ type: "notice", text: "已按系统「减少动态效果」偏好暂停。可用上一段/下一段逐段浏览。" });
      }
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // 一次性播放意图（一键放映）：就绪后自动开始；消费后从 URL 移除，刷新不重播
  useEffect(() => {
    if (!autoStart || !ready || !route || consumedIntentRef.current) return;
    consumedIntentRef.current = true;
    if (!embed) {
      const url = new URL(window.location.href);
      url.searchParams.delete("play");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      dispatch({ type: "notice", text: "已按系统「减少动态效果」偏好停用自动滚动。可逐段浏览，或点「开始放映」启用。" });
      return;
    }
    start();
  }, [autoStart, embed, ready, route, start]);

  // 布局版本变化：暂停并提示，不中途替换路线；重建测量但保持当前位置
  useEffect(() => {
    if (!ready || !route) return;
    const prev = lastVersionRef.current;
    lastVersionRef.current = layoutVersion;
    measure();
    if (prev !== null && layoutVersion !== prev) {
      const phase = stateRef.current.phase;
      if (phase === "playing" || phase === "paused" || phase === "preparing") {
        // 旧布局上的图片等待已失效，作废其回调
        cycleRef.current += 1;
        imageWaitCleanupRef.current?.();
        dispatch({ type: "layout_changed" });
      }
      posRef.current.index = nearestExpandedIndex(expandedRef.current, window.scrollY);
      posRef.current.elapsed = 0;
      posRef.current.mode = "dwell";
      publishSnapshot(true);
    }
  }, [layoutVersion, measure, publishSnapshot, ready, route]);

  // 窗口缩放/横竖屏/字体图片改变布局：ResizeObserver 更新路线，保持当前节点
  useEffect(() => {
    if (!ready || !route) return;
    const remeasure = () => {
      const key = expandedRef.current[posRef.current.index]?.key;
      measure();
      const exp = expandedRef.current;
      const same = key ? exp.findIndex((e) => e.key === key) : -1;
      posRef.current.index = same >= 0 ? same : nearestExpandedIndex(exp, window.scrollY);
      publishSnapshot(true);
    };
    const ro = new ResizeObserver(remeasure);
    ro.observe(document.body);
    window.addEventListener("orientationchange", remeasure);
    return () => {
      ro.disconnect();
      window.removeEventListener("orientationchange", remeasure);
    };
  }, [measure, publishSnapshot, ready, route]);

  // 用户接管：滚轮/触摸/滚动条偏差/滚动快捷键 → 立即暂停，保持位置不回拉
  useEffect(() => {
    if (!ready || !route) return;
    const takeover = () => {
      if (stateRef.current.phase !== "playing") return;
      dispatch({ type: "pause", reason: "manual" });
      posRef.current = {
        index: nearestExpandedIndex(expandedRef.current, window.scrollY),
        elapsed: 0,
        mode: "dwell",
        fromY: 0,
        toY: 0,
        transElapsed: 0,
      };
      publishSnapshot(true);
    };
    const onWheel = () => takeover();
    const onTouchMove = (e: TouchEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest(".playback-bar, .exhibition-nav")) return;
      takeover();
    };
    const onScroll = () => {
      if (stateRef.current.phase !== "playing") return;
      const p = programmaticRef.current;
      const now = performance.now();
      // 程序滚动窗口内且位置吻合 → 不是接管；否则视为拖动滚动条等手动输入
      if (now < p.until && Math.abs(window.scrollY - p.y) < 3) return;
      takeover();
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("scroll", onScroll);
    };
  }, [publishSnapshot, ready, route]);

  // 键盘：Space 播放/暂停，F 全屏，左右翻段，Esc 暂停/退全屏；交互控件焦点不抢快捷键
  useEffect(() => {
    if (!ready || !route) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable || t.closest("button, a, summary, [role='button']"))) return;
      const phase = stateRef.current.phase;
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        toggle();
      } else if (e.key === "f" || e.key === "F") {
        fullscreen();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        prev();
      } else if (e.key === "Escape") {
        if (!document.fullscreenElement && phase === "playing") pause();
      } else if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(e.key)) {
        // 原生滚动快捷键 = 手动接管：先暂停，保留原生滚动行为
        if (phase === "playing") takeoverViaKey();
      }
    };
    const takeoverViaKey = () => {
      dispatch({ type: "pause", reason: "manual" });
      posRef.current = {
        index: nearestExpandedIndex(expandedRef.current, window.scrollY),
        elapsed: 0,
        mode: "dwell",
        fromY: 0,
        toY: 0,
        transElapsed: 0,
      };
      publishSnapshot(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, next, pause, prev, publishSnapshot, ready, route, toggle]);

  // 页面隐藏/窗口失焦暂停；返回不自动恢复，重置时间基准
  useEffect(() => {
    const onHide = () => {
      const phase = stateRef.current.phase;
      if (phase === "playing" || phase === "preparing" || phase === "paused") {
        dispatch({ type: "pause", reason: "hidden_tab" });
        dispatch({ type: "notice", text: "页面切到后台，放映已暂停。点「继续」接着看。" });
      }
      lastTsRef.current = null;
    };
    const onVisibility = () => {
      if (document.hidden) onHide();
      else lastTsRef.current = null;
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onHide);
    };
  }, []);

  // 打印前暂停；打印后不自动续播
  useEffect(() => {
    const onBeforePrint = () => {
      const phase = stateRef.current.phase;
      if (phase === "playing" || phase === "preparing" || phase === "paused") dispatch({ type: "pause", reason: "print" });
    };
    window.addEventListener("beforeprint", onBeforePrint);
    return () => window.removeEventListener("beforeprint", onBeforePrint);
  }, []);

  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // 播放状态驱动 rAF 生命周期：单一循环，仅在 playing 时运行
  useEffect(() => {
    if (state.phase !== "playing") return;
    let id = 0;
    const loop = (ts: number) => {
      id = requestAnimationFrame(loop);
      tick(ts);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [state.phase, tick]);

  // 卸载清理：图片等待（rAF 由上面的 effect 清理）
  useEffect(
    () => () => {
      imageWaitCleanupRef.current?.();
    },
    [],
  );

  const estimatedTotalMs = useMemo(
    () => (route ? estimateTotalMs(route, speedFactor(state.speed)) : 0),
    [route, speedFactor, state.speed],
  );

  return {
    state,
    progress: snapshot.progress,
    currentChapterTitle: snapshot.chapterTitle,
    currentLabel: snapshot.label,
    estimatedTotalMs,
    waitingImage: state.phase === "paused" && state.pauseReasons.includes("image_loading"),
    reducedMotion,
    isFullscreen,
    hasRoute: !!route && route.stops.length > 0,
    start,
    pause,
    resume,
    toggle,
    prev,
    next,
    restart,
    exit,
    setSpeed,
    gotoChapter,
    fullscreen,
  };
}
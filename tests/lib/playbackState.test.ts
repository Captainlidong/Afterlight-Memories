import { describe, expect, test } from "vitest";
import {
  initialPlaybackState,
  playbackReducer,
  type PlaybackState,
} from "@/lib/exhibition/playbackState";

const playing: PlaybackState = { ...initialPlaybackState, phase: "playing", stopIndex: 2 };
const pausedManual: PlaybackState = { ...initialPlaybackState, phase: "paused", pauseReason: "manual", stopIndex: 2 };

describe("放映状态机 idle→preparing→playing↔paused→ended", () => {
  test("初始为 idle，标准速度", () => {
    expect(initialPlaybackState.phase).toBe("idle");
    expect(initialPlaybackState.speed).toBe("standard");
    expect(initialPlaybackState.pauseReason).toBeNull();
  });

  test("prepare→ready 进入播放；restart 从任意状态回到首段准备", () => {
    const preparing = playbackReducer(initialPlaybackState, { type: "prepare" });
    expect(preparing.phase).toBe("preparing");
    expect(playbackReducer(preparing, { type: "ready" }).phase).toBe("playing");
    const restarted = playbackReducer(playing, { type: "restart" });
    expect(restarted.phase).toBe("preparing");
    expect(restarted.stopIndex).toBe(0);
    expect(playbackReducer({ ...initialPlaybackState, phase: "ended" }, { type: "restart" }).phase).toBe("preparing");
  });

  test("手动暂停/继续：playing↔paused，继续清除原因", () => {
    const paused = playbackReducer(playing, { type: "pause", reason: "manual" });
    expect(paused.phase).toBe("paused");
    expect(paused.pauseReason).toBe("manual");
    expect(paused.stopIndex).toBe(2);
    const resumed = playbackReducer(paused, { type: "resume" });
    expect(resumed.phase).toBe("playing");
    expect(resumed.pauseReason).toBeNull();
  });

  test("系统暂停原因可区分：hidden_tab / print / image_loading / layout_changed / reduced_motion", () => {
    for (const reason of ["hidden_tab", "print", "image_loading", "layout_changed", "reduced_motion"] as const) {
      const s = playbackReducer(playing, { type: "pause", reason });
      expect(s.phase).toBe("paused");
      expect(s.pauseReason).toBe(reason);
    }
  });

  test("图片等待自动续播只针对 image_loading；手动/后台暂停绝不自动恢复", () => {
    const waiting = playbackReducer(playing, { type: "image_wait" });
    expect(waiting.pauseReason).toBe("image_loading");
    expect(playbackReducer(waiting, { type: "image_ready" }).phase).toBe("playing");
    expect(playbackReducer(pausedManual, { type: "image_ready" }).phase).toBe("paused");
    const hidden = playbackReducer(playing, { type: "pause", reason: "hidden_tab" });
    expect(playbackReducer(hidden, { type: "image_ready" }).phase).toBe("paused");
  });

  test("已暂停时系统暂停不覆盖用户的手动暂停", () => {
    const s = playbackReducer(pausedManual, { type: "pause", reason: "hidden_tab" });
    expect(s.pauseReason).toBe("manual");
    expect(s.pauseReasons).toEqual(["manual", "hidden_tab"]);
  });

  test("图片等待期间用户/系统暂停不被丢弃，image_ready 后仍保持暂停", () => {
    const waiting = playbackReducer(playing, { type: "image_wait" });
    const manual = playbackReducer(waiting, { type: "pause", reason: "manual" });
    expect(manual.phase).toBe("paused");
    expect(manual.pauseReason).toBe("manual");
    const afterManual = playbackReducer(manual, { type: "image_ready" });
    expect(afterManual.phase).toBe("paused");
    expect(afterManual.pauseReason).toBe("manual");
    expect(afterManual.pauseReasons).toEqual(["manual"]);

    const hidden = playbackReducer(waiting, { type: "pause", reason: "hidden_tab" });
    const afterHidden = playbackReducer(hidden, { type: "image_ready" });
    expect(afterHidden.phase).toBe("paused");
    expect(afterHidden.pauseReason).toBe("hidden_tab");
  });

  test("图片等待叠加打印/布局暂停：只解除 image_loading，其余原因保留", () => {
    const waiting = playbackReducer(playing, { type: "image_wait" });
    const printed = playbackReducer(waiting, { type: "pause", reason: "print" });
    const layouted = playbackReducer(printed, { type: "layout_changed" });
    expect(layouted.pauseReasons).toEqual(["print", "layout_changed"]);
    const ready = playbackReducer(layouted, { type: "image_ready" });
    expect(ready.phase).toBe("paused");
    expect(ready.pauseReasons).toEqual(["print", "layout_changed"]);
    expect(ready.pauseReason).toBe("layout_changed");
    expect(ready.notice).toContain("布局已更新");
  });

  test("重复暂停原因不堆积；用户继续才清空全部原因", () => {
    const a = playbackReducer(playing, { type: "pause", reason: "hidden_tab" });
    const b = playbackReducer(a, { type: "pause", reason: "hidden_tab" });
    expect(b.pauseReasons).toEqual(["hidden_tab"]);
    const resumed = playbackReducer(playbackReducer(b, { type: "image_wait" }), { type: "resume" });
    expect(resumed.phase).toBe("playing");
    expect(resumed.pauseReasons).toEqual([]);
    expect(resumed.pauseReason).toBeNull();
  });

  test("ended 只能 restart/stop，不能直接 resume", () => {
    const ended = playbackReducer(playing, { type: "end" });
    expect(ended.phase).toBe("ended");
    expect(playbackReducer(ended, { type: "resume" }).phase).toBe("ended");
    expect(playbackReducer(ended, { type: "stop" }).phase).toBe("idle");
  });

  test("goto（上一段/下一段/章节导航）默认进入暂停并保持位置索引", () => {
    const s = playbackReducer(playing, { type: "goto", stopIndex: 5 });
    expect(s.phase).toBe("paused");
    expect(s.stopIndex).toBe(5);
    expect(s.pauseReason).toBe("manual");
  });

  test("set_speed 不改变播放状态，不触发重新生成", () => {
    const s = playbackReducer(playing, { type: "set_speed", speed: "fast" });
    expect(s.phase).toBe("playing");
    expect(s.speed).toBe("fast");
    expect(playbackReducer(pausedManual, { type: "set_speed", speed: "slow" }).phase).toBe("paused");
  });

  test("layout_changed：播放/暂停中→暂停并提示；idle 不打扰", () => {
    const s = playbackReducer(playing, { type: "layout_changed" });
    expect(s.phase).toBe("paused");
    expect(s.pauseReason).toBe("layout_changed");
    expect(s.notice).toContain("布局已更新");
    expect(playbackReducer(initialPlaybackState, { type: "layout_changed" }).phase).toBe("idle");
  });

  test("stop 回到手动浏览（idle），清空位置与提示", () => {
    const s = playbackReducer({ ...playing, notice: "某提示" }, { type: "stop" });
    expect(s.phase).toBe("idle");
    expect(s.stopIndex).toBe(0);
    expect(s.notice).toBeNull();
  });

  test("notice 可设置与清除", () => {
    const s = playbackReducer(initialPlaybackState, { type: "notice", text: "浏览器未允许全屏" });
    expect(s.notice).toBe("浏览器未允许全屏");
    expect(playbackReducer(s, { type: "notice", text: null }).notice).toBeNull();
  });
});
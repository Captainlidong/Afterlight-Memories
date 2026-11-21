/**
 * 离线导出内联放映控制器（§19.9）。
 * 固定、已审阅、无框架、无 eval 的原生 JS：只执行内嵌的放映路线 JSON
 * （与浏览页同一 buildPlaybackRoute 产物），不另行推导 section 语义。
 * 状态机/几何/进度规则镜像 playbackState.ts / playbackGeometry.ts，保持单一事实源。
 * 默认静止（idle），由打开文件的访客点「开始放映」；无 JS 时本脚本不执行，
 * 控制条不注入，正文照常可读（reveal 由 staticOverride 强制可见）。
 * 所有动态文案经 textContent 写入，绝不 innerHTML；路线 JSON 中 < 已转义为 \u003c。
 */

/** 控制条/结束卡样式：自带 plain CSS（不依赖 Tailwind 候选扫描），打印隐藏。 */
export const PLAYBACK_CSS = `
.al-bar{position:fixed;left:0;right:0;bottom:0;z-index:50;padding:0.5rem 0.75rem calc(0.5rem + env(safe-area-inset-bottom,0px));background:rgba(16,17,20,0.9);backdrop-filter:blur(8px);border-top:1px solid #2a2d34;color:#f5f1e8;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
.al-row{display:flex;flex-wrap:wrap;align-items:center;gap:0.4rem;max-width:64rem;margin:0 auto}
.al-btn{display:inline-flex;align-items:center;justify-content:center;gap:0.3rem;min-height:44px;min-width:44px;padding:0 0.75rem;border-radius:0.375rem;border:1px solid #2a2d34;background:transparent;color:#f5f1e8;font-size:0.85rem;cursor:pointer;transition:opacity 0.4s ease,border-color 0.2s ease}
.al-btn:hover:not(:disabled){border-color:#c9a86a;color:#c9a86a}
.al-btn:disabled{opacity:0.4;cursor:not-allowed}
.al-primary{background:#c9a86a;color:#101114;border-color:#c9a86a;font-weight:600}
.al-primary:hover:not(:disabled){background:#d8bd85;color:#101114}
.al-select{min-height:44px;padding:0 0.5rem;border-radius:0.375rem;border:1px solid #2a2d34;background:#1a1c21;color:#f5f1e8;font-size:0.85rem;cursor:pointer}
.al-progress{flex:1 1 6rem;min-width:5rem;height:4px;border-radius:999px;background:#2a2d34;overflow:hidden}
.al-progress>span{display:block;height:100%;width:0;background:#c9a86a}
.al-info{flex:1 1 100%;margin:0.15rem 0 0;font-size:0.72rem;color:#8a8f98;text-align:center}
.al-notice{flex:1 1 100%;margin:0.15rem 0 0;font-size:0.72rem;color:#c99a4b;text-align:center}
.al-bar.al-faded .al-row>*:not(.al-primary){opacity:0.4}
.al-bar.al-faded:hover .al-row>*,.al-bar.al-faded:focus-within .al-row>*{opacity:1}
.al-end{position:fixed;inset:0;z-index:60;display:none;align-items:center;justify-content:center;background:rgba(16,17,20,0.82);backdrop-filter:blur(6px);padding:1.5rem}
.al-end.al-show{display:flex}
.al-end-card{max-width:26rem;text-align:center;color:#f5f1e8;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
.al-end-card p{font-size:1rem;line-height:1.7;margin:0 0 1.25rem}
.al-end-actions{display:flex;flex-wrap:wrap;gap:0.5rem;justify-content:center}
@media (prefers-reduced-motion: reduce){.al-btn{transition:none}}
@media print{.al-bar,.al-end{display:none!important}}
`;

/** 固定控制器脚本正文（用于 CSP sha256 哈希；不含任何用户/模型文案）。 */
export const PLAYBACK_CONTROLLER = `
(function () {
  "use strict";
  var dataEl = document.getElementById("afterlight-playback-route");
  if (!dataEl) return;
  var route;
  try { route = JSON.parse(dataEl.textContent || "{}"); } catch (e) { return; }
  if (!route || !route.stops || !route.stops.length) return;

  var TRANSITION = 1400;
  var NAV_OFFSET = 0;
  var IMAGE_WAIT_TIMEOUT = 8000;
  var FACTORS = { slow: 0.75, standard: 1, fast: 1.5 };
  var SPEED_LABELS = { slow: "舒缓", standard: "标准", fast: "快速" };
  var END_COPY = "放映结束。你可以重新观看，或回到作品继续调整。";
  var clamp = function (v, lo, hi) { return Math.min(hi, Math.max(lo, v)); };
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- 状态机（镜像 playbackState.ts）----
  var REASON_PRIORITY = ["manual", "layout_changed", "hidden_tab", "print", "reduced_motion", "image_loading"];
  var S = { phase: "idle", pauseReason: null, pauseReasons: [], stopIndex: 0, speed: "standard", notice: null };
  function reasonsOf() {
    if (S.pauseReasons) return S.pauseReasons;
    return S.pauseReason ? [S.pauseReason] : [];
  }
  function primaryReason(rs) {
    for (var i = 0; i < REASON_PRIORITY.length; i++) if (rs.indexOf(REASON_PRIORITY[i]) >= 0) return REASON_PRIORITY[i];
    return rs.length ? rs[0] : null;
  }
  function setPaused(rs) {
    S.phase = "paused"; S.pauseReasons = rs; S.pauseReason = primaryReason(rs);
  }
  function addReason(r) {
    var rs = reasonsOf().slice();
    if (rs.indexOf(r) < 0) rs.push(r);
    setPaused(rs);
  }
  function dispatch(a) {
    switch (a.type) {
      case "prepare": case "restart":
        S.phase = "preparing"; S.pauseReason = null; S.pauseReasons = []; S.stopIndex = 0; S.notice = null; break;
      case "ready":
        if (S.phase === "preparing") S.phase = "playing"; break;
      case "pause":
        if (S.phase !== "playing" && S.phase !== "preparing" && S.phase !== "paused") return;
        addReason(a.reason); break;
      case "resume":
        if (S.phase === "paused") { S.phase = "playing"; S.pauseReason = null; S.pauseReasons = []; S.notice = null; } break;
      case "end":
        if (S.phase === "playing") { S.phase = "ended"; S.pauseReason = null; S.pauseReasons = []; } break;
      case "stop":
        S.phase = "idle"; S.pauseReason = null; S.pauseReasons = []; S.stopIndex = 0; S.notice = null; break;
      case "goto":
        S.phase = "paused"; S.pauseReason = "manual"; S.pauseReasons = ["manual"]; S.stopIndex = a.stopIndex; break;
      case "set_speed":
        S.speed = a.speed; break;
      case "image_wait":
        if (S.phase === "playing" || S.phase === "paused") addReason("image_loading");
        break;
      case "image_ready":
        if (S.phase === "paused" && reasonsOf().indexOf("image_loading") >= 0) {
          var rest = reasonsOf().filter(function (r) { return r !== "image_loading"; });
          if (!rest.length) { S.phase = "playing"; S.pauseReason = null; S.pauseReasons = []; }
          else setPaused(rest);
        }
        break;
      case "notice":
        S.notice = a.text; break;
    }
    render();
  }
  function factor() { return FACTORS[S.speed] || 1; }

  // ---- 几何（镜像 playbackGeometry.ts）----
  function splitDwell(total, parts) {
    var base = Math.floor(total / parts), rem = total - base * parts, out = [];
    for (var i = 0; i < parts; i++) out.push(base + (i < rem ? 1 : 0));
    return out;
  }
  function expandRoute(measures, viewportH, maxScrollY) {
    var viewH = Math.max(200, viewportH - NAV_OFFSET), step = viewH * 0.7, out = [];
    route.stops.forEach(function (stop, stopIndex) {
      var m = measures[stop.sectionId] || { top: 0, height: viewH };
      var base = clamp(m.top - NAV_OFFSET, 0, maxScrollY);
      var overflow = m.height - viewH;
      var docks = overflow > viewH * 0.05 ? 1 + Math.ceil(overflow / step) : 1;
      var targets = [];
      for (var i = 0; i < docks; i++) {
        var raw = docks === 1 ? base : base + Math.round((i * overflow) / (docks - 1));
        var y = clamp(raw, 0, maxScrollY);
        if (!targets.length || targets[targets.length - 1] !== y) targets.push(y);
      }
      var dwells = splitDwell(stop.dwellMs, targets.length);
      targets.forEach(function (targetY, subIndex) {
        out.push({ key: stop.sectionId + "#" + subIndex, sectionId: stop.sectionId, stopIndex: stopIndex, subIndex: subIndex, subCount: targets.length, targetY: targetY, dwellMs: dwells[subIndex], photoIds: stop.photoIds });
      });
    });
    return out;
  }
  function nearestIndex(scrollY) {
    if (!expanded.length) return 0;
    var best = 0, bestDist = Infinity;
    expanded.forEach(function (e, i) { var d = Math.abs(e.targetY - scrollY); if (d < bestDist) { bestDist = d; best = i; } });
    return best;
  }
  function computeProgress(index, elapsed) {
    var n = expanded.length; if (!n) return 0;
    var total = 0; for (var k = 0; k < n; k++) total += expanded[k].dwellMs; total += (n - 1) * TRANSITION;
    if (total <= 0) return 0;
    var i = clamp(index, 0, n - 1), done = 0;
    for (var j = 0; j < i; j++) done += expanded[j].dwellMs + TRANSITION;
    done += clamp(elapsed, 0, expanded[i].dwellMs);
    return clamp(done / total, 0, 1);
  }
  function estimateTotal() { var f = factor(); return f <= 0 ? 0 : Math.round(route.baseTotalMs / f); }
  function fmt(ms) { var s = Math.round(ms / 1000), m = Math.floor(s / 60), sec = s % 60; return m > 0 ? m + " 分 " + sec + " 秒" : sec + " 秒"; }

  var expanded = [];
  var pos = { index: 0, elapsed: 0, mode: "dwell", fromY: 0, toY: 0, transElapsed: 0 };
  var raf = null, lastTs = null, waitingImage = false;
  var programmatic = { y: 0, until: 0 };
  var imageWaitCleanup = null;
  var cycle = 0;

  function measure() {
    var measures = {}, maxScrollY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    route.stops.forEach(function (stop) {
      var el = document.getElementById(stop.sectionId);
      if (el) { var r = el.getBoundingClientRect(); measures[stop.sectionId] = { top: r.top + window.scrollY, height: r.height }; }
    });
    expanded = expandRoute(measures, window.innerHeight, maxScrollY);
    if (pos.index >= expanded.length) pos.index = Math.max(0, expanded.length - 1);
  }
  function scrollToY(y) {
    programmatic.y = y; programmatic.until = performance.now() + 200;
    window.scrollTo({ top: y, behavior: "instant" });
  }
  function ease(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

  function stopLoop() { if (raf != null) { cancelAnimationFrame(raf); raf = null; } lastTs = null; }
  // 唯一循环入口：同步回调（零转场/图片已就绪）里重复调用也不会开出第二条 rAF
  function schedule() { if (raf == null && S.phase === "playing") raf = requestAnimationFrame(tick); }
  function ensureLoop() { lastTs = null; schedule(); }

  function waitForImages(index, onReady) {
    if (imageWaitCleanup) { imageWaitCleanup(); imageWaitCleanup = null; }
    var stop = expanded[index]; if (!stop) { onReady(); return; }
    var section = document.getElementById(stop.sectionId); if (!section) { onReady(); return; }
    var imgs = Array.prototype.slice.call(section.querySelectorAll("img"));
    var pending = imgs.filter(function (im) { return !im.complete; });
    if (!pending.length) { onReady(); return; }
    waitingImage = true; dispatch({ type: "image_wait" }); render();
    var done = false, remaining = pending.length, myCycle = cycle;
    function finish() {
      if (done) return; done = true;
      // 停止/重播后旧回调作废，不得解除新的暂停或续播
      if (myCycle !== cycle) return;
      waitingImage = false;
      if (imageWaitCleanup) { imageWaitCleanup(); imageWaitCleanup = null; }
      onReady();
    }
    var timer = setTimeout(finish, IMAGE_WAIT_TIMEOUT);
    function one() { remaining -= 1; if (remaining <= 0) finish(); }
    pending.forEach(function (im) { im.addEventListener("load", one, { once: true }); im.addEventListener("error", one, { once: true }); });
    imageWaitCleanup = function () { clearTimeout(timer); pending.forEach(function (im) { im.removeEventListener("load", one); im.removeEventListener("error", one); }); };
  }

  function beginTransition(nextIndex) {
    pos.fromY = window.scrollY; pos.toY = expanded[nextIndex].targetY;
    pos.index = nextIndex; pos.mode = "transition"; pos.transElapsed = 0; pos.elapsed = 0;
    S.stopIndex = nextIndex;
  }
  function tick(ts) {
    raf = null;
    if (S.phase !== "playing") { lastTs = null; return; }
    if (lastTs == null) { lastTs = ts; schedule(); return; }
    var dt = Math.min(ts - lastTs, 100); lastTs = ts;
    var f = factor();
    if (pos.mode === "transition") {
      var dur = reduced ? 0 : TRANSITION / f;
      pos.transElapsed += dt;
      var t = dur <= 0 ? 1 : clamp(pos.transElapsed / dur, 0, 1);
      scrollToY(pos.fromY + (pos.toY - pos.fromY) * ease(t));
      if (t >= 1) {
        pos.mode = "dwell"; pos.elapsed = 0;
        waitForImages(pos.index, function () { dispatch({ type: "image_ready" }); ensureLoop(); });
      }
    } else {
      pos.elapsed += dt;
      var dwell = expanded[pos.index] ? expanded[pos.index].dwellMs : 0;
      if (pos.elapsed >= dwell / f) {
        if (pos.index < expanded.length - 1) { beginTransition(pos.index + 1); }
        else { dispatch({ type: "end" }); stopLoop(); render(); return; }
      }
    }
    updateLive();
    schedule();
  }

  function beginAt(index) {
    cycle += 1;
    measure();
    pos.index = clamp(index, 0, Math.max(0, expanded.length - 1));
    pos.elapsed = 0; pos.mode = "dwell"; pos.fromY = 0; pos.toY = 0; pos.transElapsed = 0;
    S.stopIndex = pos.index;
    if (expanded[pos.index]) scrollToY(expanded[pos.index].targetY);
    waitForImages(pos.index, function () { dispatch({ type: "ready" }); dispatch({ type: "image_ready" }); ensureLoop(); });
    render();
  }
  function start() { dispatch({ type: "prepare" }); beginAt(0); }
  function restart() { dispatch({ type: "restart" }); beginAt(0); }
  function pause(reason) { dispatch({ type: "pause", reason: reason }); stopLoop(); }
  function resume() {
    if (S.phase !== "paused") return;
    // 按最新几何与当前滚动位置重新停靠，旧转场状态一律丢弃
    measure();
    pos.index = nearestIndex(window.scrollY); pos.elapsed = 0; pos.mode = "dwell";
    pos.fromY = 0; pos.toY = 0; pos.transElapsed = 0;
    S.stopIndex = pos.index;
    dispatch({ type: "resume" }); lastTs = null; ensureLoop();
  }
  function toggle() {
    if (S.phase === "playing" || S.phase === "preparing") pause("manual");
    else if (S.phase === "paused") resume();
    else start();
  }
  function jumpTo(index) {
    measure();
    var i = clamp(index, 0, Math.max(0, expanded.length - 1));
    dispatch({ type: "goto", stopIndex: i });
    pos.index = i; pos.elapsed = 0; pos.mode = "dwell";
    if (expanded[i]) scrollToY(expanded[i].targetY);
    stopLoop(); render();
  }
  function exit() { cycle += 1; dispatch({ type: "stop" }); stopLoop(); render(); }
  function fullscreen() {
    var el = document.documentElement;
    if (document.fullscreenElement) { if (document.exitFullscreen) document.exitFullscreen(); return; }
    if (el.requestFullscreen) { el.requestFullscreen().catch(function () { dispatch({ type: "notice", text: "浏览器未允许全屏，已在页内放映。" }); }); }
    else dispatch({ type: "notice", text: "浏览器未允许全屏，已在页内放映。" });
  }

  // ---- 控制条 DOM（createElement + textContent，绝不 innerHTML）----
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  var bar = el("div", "al-bar");
  var row = el("div", "al-row");
  var primary = el("button", "al-btn al-primary", "▶ 开始放映"); primary.type = "button";
  var prev = el("button", "al-btn", "← 上一段"); prev.type = "button";
  var next = el("button", "al-btn", "下一段 →"); next.type = "button";
  var again = el("button", "al-btn", "⟲ 从头播放"); again.type = "button";
  var speed = el("select", "al-select"); speed.setAttribute("aria-label", "放映速度");
  ["slow", "standard", "fast"].forEach(function (id) { var o = el("option", null, SPEED_LABELS[id]); o.value = id; speed.appendChild(o); });
  speed.value = "standard";
  var fsBtn = el("button", "al-btn", "全屏"); fsBtn.type = "button";
  var manual = el("button", "al-btn", "手动浏览"); manual.type = "button";
  var progress = el("div", "al-progress"); progress.setAttribute("role", "progressbar");
  progress.setAttribute("aria-label", "放映进度"); progress.setAttribute("aria-valuemin", "0"); progress.setAttribute("aria-valuemax", "100");
  var progressFill = el("span"); progress.appendChild(progressFill);
  var info = el("p", "al-info");
  var notice = el("p", "al-notice"); notice.setAttribute("role", "status");
  row.appendChild(primary); row.appendChild(prev); row.appendChild(next); row.appendChild(again);
  row.appendChild(speed); row.appendChild(fsBtn); row.appendChild(manual); row.appendChild(progress);
  bar.appendChild(row); bar.appendChild(info); bar.appendChild(notice);
  document.body.appendChild(bar);

  var end = el("div", "al-end");
  var endCard = el("div", "al-end-card");
  endCard.appendChild(el("p", null, END_COPY));
  var endActions = el("div", "al-end-actions");
  var endRestart = el("button", "al-btn al-primary", "重新放映"); endRestart.type = "button";
  var endManual = el("button", "al-btn", "手动浏览"); endManual.type = "button";
  endActions.appendChild(endRestart); endActions.appendChild(endManual);
  endCard.appendChild(endActions); end.appendChild(endCard); document.body.appendChild(end);

  primary.addEventListener("click", toggle);
  prev.addEventListener("click", function () { jumpTo(S.stopIndex - 1); });
  next.addEventListener("click", function () { jumpTo(S.stopIndex + 1); });
  again.addEventListener("click", restart);
  manual.addEventListener("click", exit);
  fsBtn.addEventListener("click", fullscreen);
  speed.addEventListener("change", function () { dispatch({ type: "set_speed", speed: speed.value }); });
  endRestart.addEventListener("click", function () { end.classList.remove("al-show"); restart(); });
  endManual.addEventListener("click", function () { end.classList.remove("al-show"); exit(); });

  function currentStop() { var e = expanded[pos.index]; return e ? route.stops[e.stopIndex] : route.stops[0]; }
  function updateLive() {
    var p = computeProgress(pos.index, pos.elapsed);
    progressFill.style.width = (p * 100).toFixed(1) + "%";
    progress.setAttribute("aria-valuenow", String(Math.round(p * 100)));
    var st = currentStop();
    var chapter = st && st.chapterTitle ? st.chapterTitle + " · " : "";
    info.textContent = chapter + (st ? st.label : "") + " · 预计约 " + fmt(estimateTotal());
  }
  function render() {
    var playing = S.phase === "playing", paused = S.phase === "paused", preparing = S.phase === "preparing";
    primary.disabled = preparing;
    primary.textContent = preparing ? "准备中…" : playing ? "❚❚ 暂停" : paused ? "▶ 继续" : "▶ 开始放映";
    prev.disabled = S.stopIndex <= 0;
    next.disabled = S.stopIndex >= expanded.length - 1;
    manual.style.display = S.phase === "idle" ? "none" : "";
    fsBtn.textContent = document.fullscreenElement ? "退出全屏" : "全屏";
    speed.value = S.speed;
    notice.textContent = S.notice || "";
    notice.style.display = S.notice ? "" : "none";
    if (S.phase === "ended") { end.classList.add("al-show"); info.textContent = ""; }
    else { end.classList.remove("al-show"); }
    if (waitingImage) info.textContent = "正在等待图片加载…";
    else if (S.phase === "idle") info.textContent = "点「开始放映」自动滚动浏览，随时可用滚轮接管。";
    else updateLive();
    bar.classList.toggle("al-faded", playing && faded);
  }

  // ---- 淡出（播放中 3s 无交互）----
  var faded = false, fadeTimer = null;
  function wake() {
    faded = false; bar.classList.remove("al-faded");
    if (fadeTimer) clearTimeout(fadeTimer);
    if (S.phase === "playing") fadeTimer = setTimeout(function () { faded = true; render(); }, 3000);
  }
  ["pointermove", "touchstart", "keydown"].forEach(function (ev) { window.addEventListener(ev, wake, { passive: true }); });

  // ---- 接管检测 ----
  function takeover() {
    if (S.phase === "playing" || S.phase === "preparing") { pause("manual"); }
  }
  window.addEventListener("wheel", takeover, { passive: true });
  window.addEventListener("touchmove", takeover, { passive: true });
  window.addEventListener("scroll", function () {
    if (S.phase !== "playing") return;
    if (performance.now() < programmatic.until && Math.abs(window.scrollY - programmatic.y) < 3) return;
    if (Math.abs(window.scrollY - (expanded[pos.index] ? expanded[pos.index].targetY : 0)) > 4) takeover();
  }, { passive: true });

  // ---- 键盘 ----
  window.addEventListener("keydown", function (e) {
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    if (t && t.closest && t.closest("button, a, summary, [role='button']")) return;
    if (e.key === " " || e.code === "Space") { e.preventDefault(); toggle(); }
    else if (e.key === "f" || e.key === "F") { fullscreen(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); jumpTo(S.stopIndex + 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); jumpTo(S.stopIndex - 1); }
    else if (e.key === "Escape") { if (document.fullscreenElement) { if (document.exitFullscreen) document.exitFullscreen(); } else if (S.phase === "playing") pause("manual"); }
  });

  // ---- 后台 / 打印 / 减少动态 ----
  function pausable() { return S.phase === "playing" || S.phase === "preparing" || S.phase === "paused"; }
  document.addEventListener("visibilitychange", function () {
    if (document.hidden && pausable()) {
      pause("hidden_tab"); dispatch({ type: "notice", text: "页面切到后台，放映已暂停。点「继续」接着看。" });
    } else { lastTs = null; }
  });
  window.addEventListener("blur", function () {
    if (pausable()) { pause("hidden_tab"); dispatch({ type: "notice", text: "页面切到后台，放映已暂停。点「继续」接着看。" }); }
  });
  window.addEventListener("beforeprint", function () { if (pausable()) pause("print"); stopLoop(); });
  window.addEventListener("afterprint", function () { lastTs = null; /* 不自动恢复 */ });
  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    var onMq = function () {
      reduced = mq.matches;
      if (reduced && pausable()) { pause("reduced_motion"); dispatch({ type: "notice", text: "已按系统「减少动态效果」偏好停用自动滚动。可逐段浏览，或点「开始放映」启用。" }); }
    };
    if (mq.addEventListener) mq.addEventListener("change", onMq); else if (mq.addListener) mq.addListener(onMq);
    if (reduced) dispatch({ type: "notice", text: "已按系统「减少动态效果」偏好停用自动滚动。可逐段浏览，或点「开始放映」启用。" });
  }
  window.addEventListener("resize", function () { measure(); render(); });
  window.addEventListener("orientationchange", function () { measure(); render(); });
  document.addEventListener("fullscreenchange", render);

  measure();
  render();
})();
`;
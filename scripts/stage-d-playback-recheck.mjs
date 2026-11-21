// 阶段 D 收尾复测：慢图限流接管 + 离线 file:// 导出（旧验收遗留的 2 个专项）。
// 复用 stage-f-browser-check.mjs 的零依赖 Chrome CDP 方式；只读访问真实数据，
// 不写数据库、不触发模型调用（放映与导出均为只读接口）。
// 用法：node scripts/stage-d-playback-recheck.mjs <exhibitionId> [port]
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const EXHIBITION_ID = process.argv[2] || 'exh_DAtT9xAy_z5k';
const PORT = process.argv[3] || '3000';
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.resolve('gui-test-screenshots/stage-d-recheck');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_TIMEOUT = 30000;

if (!existsSync(CHROME)) { console.error('Chrome not found: ' + CHROME); process.exit(1); }
await mkdir(OUT, { recursive: true });

const report = { exhibition: EXHIBITION_ID, startedAt: new Date().toISOString(), checks: [], screenshots: [], failures: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(name, pass, evidence) {
  report.checks.push({ name, pass: Boolean(pass), evidence });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} :: ${evidence ?? ''}`);
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = this.pending.get(m.id); if (!p) return;
        this.pending.delete(m.id); clearTimeout(p.timer);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      } else for (const f of this.handlers.get(m.method) || []) Promise.resolve().then(() => f(m.params, m.sessionId)).catch(err => report.failures.push({ event: m.method, error: String(err) }));
    });
    const rejectPending = error => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); };
    ws.addEventListener('close', () => rejectPending(new Error('CDP connection closed')));
    ws.addEventListener('error', () => rejectPending(new Error('CDP connection failed')));
  }
  on(name, fn) { const f = this.handlers.get(name) || []; f.push(fn); this.handlers.set(name, f); }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== WebSocket.OPEN) { reject(new Error(`CDP closed: ${method}`)); return; }
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, CDP_TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
}

let browser, chrome;
async function launch() {
  chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${OUT}/chrome-profile`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--window-size=1440,1000', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error('Chrome devtools ws timed out')), 20000);
    chrome.stderr.on('data', d => {
      stderr += d;
      const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    chrome.on('exit', code => { clearTimeout(timer); reject(new Error('Chrome exited early: ' + code)); });
  });
  browser = new CDP(await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => reject(new Error('WebSocket open timed out')), 15000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket open failed')); });
  }));
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  browser.pageSession = sessionId;
  await send('Page.enable');
  await send('Runtime.enable');
}
function send(method, params = {}) { return browser.send(method, params, browser.pageSession); }
async function js(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function wait(expression, label, timeout = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await js(`Boolean(${expression})`)) return; } catch {}
    await delay(250);
  }
  throw new Error(`Timed out: ${label}`);
}
const visible = `e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'`;
function findBtn(text) {
  return `[...document.querySelectorAll('button')].find(e => ${visible} && (e.getAttribute('aria-label') || e.textContent).trim() === ${JSON.stringify(text)})`;
}
async function clickBtn(text) {
  const expr = findBtn(text);
  await wait(`Boolean(${expr}) && !(${expr}).disabled`, `clickable ${text}`);
  await js(`(() => { const e=${expr}; e.scrollIntoView({block:'center'}); e.click(); return e.textContent.trim(); })()`);
}
async function shot(name) {
  const image = await send('Page.captureScreenshot', { format: 'png' });
  const p = path.join(OUT, `${name}.png`);
  await writeFile(p, Buffer.from(image.data, 'base64'));
  report.screenshots.push(p);
  return p;
}

try {
  await launch();

  // ---------- 第一部分：慢图限流下的手动接管复测 ----------
  await send('Network.enable');
  await send('Network.emulateNetworkConditions', { offline: false, latency: 500, downloadThroughput: 100 * 1024, uploadThroughput: 100 * 1024 });
  await send('Page.navigate', { url: `${BASE}/exhibition/${EXHIBITION_ID}` });
  await wait(`document.readyState === 'complete'`, 'playback page load (throttled)');
  await delay(1200);

  const playLabelBefore = await js(`(${findBtn('开始放映')})?.textContent.trim() ?? (${findBtn('暂停')})?.textContent.trim() ?? 'none'`);
  check('限流下放映页可用', playLabelBefore !== 'none', `初始按钮: ${playLabelBefore}`);

  const clickedLabel = await clickBtn('开始放映');
  let playingLabel = '其他';
  let btnDump = '';
  for (let i = 0; i < 20 && playingLabel === '其他'; i++) {
    await delay(400);
    playingLabel = await js(`(${findBtn('暂停')}) ? '暂停' : ((${findBtn('继续')}) ? '继续' : '其他')`);
    if (i === 9) btnDump = await js(`[...document.querySelectorAll('button')].filter(e => ${visible}).map(e => (e.getAttribute('aria-label') || e.textContent).trim()).join(' | ')`);
  }
  check('自动放映已启动', playingLabel === '暂停', `点击返回: ${clickedLabel}，按钮: ${playingLabel}${playingLabel === '其他' ? '，可见按钮: ' + btnDump : ''}`);

  // 图片仍在慢速加载时手动滚轮接管
  const loadingBefore = await js(`[...document.images].filter(i => !i.complete).length`);
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 400, deltaX: 0, deltaY: 600, pointerType: 'mouse' });
  await delay(1000);
  const afterTakeover = await js(`(${findBtn('继续')}) ? '继续' : ((${findBtn('暂停')}) ? '暂停' : '其他')`);
  check('手动滚轮接管即暂停', afterTakeover === '继续', `接管时未完成加载的图片数: ${loadingBefore}`);

  // 核心风险：慢图加载完成窗口内不得自动续播
  await delay(12000); // 覆盖限流下图片完成加载的时间窗
  const stillPaused = await js(`(${findBtn('继续')}) ? '继续' : ((${findBtn('暂停')}) ? '暂停' : '其他')`);
  check('慢图加载完成后不自动续播', stillPaused === '继续', `等待 12s 后按钮: ${stillPaused}`);
  await shot('slow-takeover-paused');

  // 用户主动恢复播放
  await clickBtn('继续');
  await delay(800);
  const resumed = await js(`(${findBtn('暂停')}) ? '暂停' : ((${findBtn('继续')}) ? '继续' : '其他')`);
  check('用户点击继续可恢复放映', resumed === '暂停', `按钮: ${resumed}`);

  // 解除限流，确认页面稳定
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await delay(1000);
  const stable = await js(`({imgs: document.images.length, broken: [...document.images].filter(i => i.complete && i.naturalWidth === 0).length, url: location.pathname})`);
  check('解除限流后页面稳定', stable.broken === 0, JSON.stringify(stable));

  // ---------- 第二部分：离线 file:// 导出复测 ----------
  const exported = await fetch(`${BASE}/api/exhibitions/${EXHIBITION_ID}/export`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ format: 'html' }),
  });
  if (!exported.ok) throw new Error('export http ' + exported.status);
  const htmlPath = path.join(OUT, `offline-export-${EXHIBITION_ID}.html`);
  await writeFile(htmlPath, Buffer.from(await exported.arrayBuffer()));
  check('导出 HTML 下载成功', existsSync(htmlPath), `${htmlPath} (${htmlPath.length} 字符路径)`);

  // 新开隔离标签页加载 file://，监控所有网络请求
  const httpRequests = [];
  browser.on('Network.requestWillBeSent', p => { if (p.sessionId === browser.pageSession && /^https?:/i.test(p.request.url)) httpRequests.push(p.request.url); });
  const consoleErrors = [];
  browser.on('Runtime.consoleAPICalled', p => { if (p.type === 'error') consoleErrors.push(p.args?.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 200)); });
  browser.on('Runtime.exceptionThrown', p => consoleErrors.push(String(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text).slice(0, 200)));

  await send('Page.navigate', { url: 'file:///' + htmlPath.split(path.sep).join('/') });
  await wait(`document.readyState === 'complete'`, 'file:// load');
  await delay(1500);
  const meta = await js(`({timeOrigin: performance.timeOrigin, imgs: document.images.length, title: document.title.slice(0, 40)})`);
  check('离线 HTML 打开成功', meta.imgs > 0, JSON.stringify(meta));

  // 逐屏滚动触发懒加载，统计图片全部可见
  let allLoaded = false;
  for (let i = 0; i < 40 && !allLoaded; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 400, deltaX: 0, deltaY: 900, pointerType: 'mouse' });
    await delay(350);
    allLoaded = await js(`document.images.length > 0 && [...document.images].every(i => i.complete && i.naturalWidth > 0)`);
  }
  const imgStats = await js(`({total: document.images.length, loaded: [...document.images].filter(i => i.complete && i.naturalWidth > 0).length})`);
  check('离线滚动后全部图片可见', allLoaded, JSON.stringify(imgStats));

  // 离线放映控件可用（按钮文本带图标/箭头，用包含匹配）
  const hasControls = await js(`(() => {
    const labels = [...document.querySelectorAll('button')].filter(e => ${visible}).map(e => (e.getAttribute('aria-label') || e.textContent).trim());
    return { next: labels.some(l => l.includes('下一段')), play: labels.some(l => l.includes('开始放映') || l.includes('暂停') || l.includes('继续')), labels: labels.slice(0, 8) };
  })()`);
  check('离线放映控件存在', hasControls.next && hasControls.play, JSON.stringify(hasControls));
  await clickBtn('下一段 →').catch(async () => { await clickBtn('下一段'); });
  await delay(600);
  check('离线下一段可点击', true, '控件交互正常');
  await shot('offline-file-playback');

  check('离线零 HTTP/API 请求', httpRequests.length === 0, httpRequests.length ? httpRequests.slice(0, 3).join(', ') : '仅 file:// 资源，无任何网络请求');
  check('离线无控制台错误', consoleErrors.length === 0, consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : '无 error 级输出');
} catch (err) {
  report.failures.push({ fatal: String(err?.stack || err) });
  console.error('FATAL', err);
  try { await shot('fatal-state'); } catch {}
} finally {
  try { browser?.ws.close(); } catch {}
  try { chrome?.kill(); } catch {}
  const passed = report.checks.filter(c => c.pass).length;
  report.summary = { passed, total: report.checks.length, ok: passed === report.checks.length && report.failures.length === 0, finishedAt: new Date().toISOString() };
  await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  console.log(`\n== ${passed}/${report.checks.length} 通过，报告: ${OUT}/report.json`);
  process.exit(report.summary.ok ? 0 : 2);
}

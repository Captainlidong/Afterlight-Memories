// Isolated UI verification: Node 24 + Chrome CDP, no browser dependencies.
// Run: node scripts/stage-f-browser-check.mjs [ai|demo|all|resume-demo|material-gates|production-readonly] [exhibition-id]
// production-readonly requires an existing exhibition ID; it never seeds, exports or changes settings.
// Only writes artifacts to the explicitly isolated Stage F test directory.
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const ROOT = 'D:/Qoder/Qoder Creativity Cup 2026';
const DATA = 'C:/Users/CAPTAI~1/AppData/Local/Temp/afterlight-stage-f-WFavmC';
const BASE = 'http://localhost:3000';
const phase = process.argv[2] ?? 'all';
const phases = ['ai', 'demo', 'all', 'resume-demo', 'material-gates', 'production-readonly'];
if (!phases.includes(phase)) throw new Error(`Unknown phase: ${phase}; expected ${phases.join(', ')}`);
const readOnly = phase === 'production-readonly';
const exhibitionId = process.argv[3];
if (readOnly && !/^exh_[a-zA-Z0-9_-]+$/.test(exhibitionId || '')) throw new Error('production-readonly requires an explicit existing exhibition ID (exh_...)');
const CDP_TIMEOUT = 30000;
const MOBILE_WIDTHS = [360, 390];
const OUT = `${DATA}/browser-${phase}-${Date.now()}`;
if (!existsSync(DATA)) throw new Error('Explicit isolated output directory is missing');
await mkdir(OUT);
const report = { phase, output: OUT, checks: [], screenshots: [], mobileViews: [], console: [], network: [], failures: [], interceptions: [], downloads: [], origins: [] };
let browser, chrome, page, scenario = null, testReply = 'partial', statusHits = 0, testPosts = 0;
const demoIds = new Set();
let closing = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(name, pass, evidence) {
  report.checks.push({ name, pass: Boolean(pass), evidence });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
}
class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error) p.reject(new Error(JSON.stringify(m.error)));
        else p.resolve(m.result);
      } else for (const f of this.handlers.get(m.method) || []) Promise.resolve().then(() => f(m.params, m.sessionId)).catch(error => { if (!closing) report.failures.push({ event: m.method, error: String(error) }); });
    });
    const rejectPending = error => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
      this.pending.clear();
    };
    ws.addEventListener('close', () => rejectPending(new Error('Chrome CDP connection closed')));
    ws.addEventListener('error', () => rejectPending(new Error('Chrome CDP connection failed')));
  }
  on(name, fn) { const f = this.handlers.get(name) || []; f.push(fn); this.handlers.set(name, f); }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== WebSocket.OPEN) { reject(new Error(`CDP is not open: ${method}`)); return; }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP response timed out after ${CDP_TIMEOUT}ms: ${method} (id=${id})`));
      }, CDP_TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
}
async function send(method, params = {}) { return browser.send(method, params, page); }
async function js(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function wait(expression, label, timeout = 90000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) {
    try { last = await js(`Boolean(${expression})`); if (last) return last; } catch (e) { last = String(e); }
    await delay(200);
  }
  throw new Error(`Timed out: ${label}; last=${JSON.stringify(last)}`);
}
const visible = `e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'`;
function find(text, selector = 'button,a,summary', exact = true) {
  return `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e => ${visible} && (e.getAttribute('aria-label') || e.textContent).trim()${exact ? '===' : '.includes('}${JSON.stringify(text)}${exact ? '' : ')' } )`;
}
async function click(text, options = {}) {
  const expr = find(text, options.selector, options.exact ?? true);
  await wait(`Boolean(${expr}) && !(${expr}).disabled`, `clickable ${text}`);
  await js(`(() => { const e=${expr}; e.scrollIntoView({block:'center'}); e.click(); return true; })()`);
}
async function toggleLabel(text) {
  const expr = `[...document.querySelectorAll('label')].find(e => e.textContent.includes(${JSON.stringify(text)}))?.querySelector('input[type=checkbox]')`;
  await wait(`Boolean(${expr}) && !(${expr}).disabled`, `checkbox ${text}`);
  await js(`(${expr}).click()`);
}
async function shot(name, full = false) {
  const size = await send('Page.getLayoutMetrics');
  const params = { format: 'png', captureBeyondViewport: full };
  if (full) params.clip = { x: 0, y: 0, width: size.cssContentSize.width, height: Math.min(size.cssContentSize.height, 18000), scale: 1 };
  const image = await send('Page.captureScreenshot', params);
  const path = `${OUT}/${name}.png`;
  await writeFile(path, Buffer.from(image.data, 'base64'));
  report.screenshots.push(path);
  return path;
}
async function snapshot(name) {
  const value = await js(`({url:location.href,title:document.title,text:document.body.innerText,buttons:[...document.querySelectorAll('button,a,summary')].filter(e=>${visible}).map(e=>({text:e.textContent.trim(),label:e.getAttribute('aria-label'),disabled:e.disabled,pressed:e.getAttribute('aria-pressed')})),inputs:[...document.querySelectorAll('input')].map(e=>({type:e.type,checked:e.checked,disabled:e.disabled})),timeOrigin:performance.timeOrigin,visibility:document.visibilityState,width:innerWidth,scrollWidth:document.documentElement.scrollWidth})`);
  await writeFile(`${OUT}/${name}.json`, JSON.stringify(value, null, 2));
  return value;
}
async function navigate(url, nextScenario = null) {
  scenario = nextScenario; statusHits = 0;
  await send('Page.navigate', { url });
  await wait(`document.readyState === 'complete' && location.href === ${JSON.stringify(url)}`, `navigate ${url}`);
}
async function desktop() { await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); }
async function mobile(width) { await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true }); }
const consentControls = `[...document.querySelectorAll('label')].filter(e => e.querySelector('input[type=checkbox]'))`;
const playbackControls = `[...document.querySelectorAll('.playback-bar button, .playback-bar a')]`;
const progressControls = `[...document.querySelectorAll('progress,[role="progressbar"],[role="status"],[aria-live],h1,h2,h3,p,button,span')].filter(e => e.matches('progress,[role="progressbar"]') || /正在分析|分析中|正在生成|生成中|正在发现|生成完成|已完成|生成进度|读取照片|组织影展内容|安排观看节奏|检查影展/.test(e.textContent))`;
// Resize/observe only: never repeat consent, selection, generation or playback mutations per width.
// Optional progress can disappear between samples; record absence instead of claiming it was seen.
async function mobileViews(name, controlsExpression = '[]', { optional = false } = {}) {
  for (const width of MOBILE_WIDTHS) {
    await mobile(width);
    const evidence = await js(`(() => {
      const controls = (${controlsExpression}).filter(e => ${visible});
      if (controls[0]) controls[0].scrollIntoView({block:'center',inline:'nearest'});
      else window.scrollTo(0,0);
      return {
        url: location.href, width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth, visibility: document.visibilityState,
        images: { total:document.images.length, loaded:[...document.images].filter(i => i.complete && i.naturalWidth > 0).length,
          embedded:[...document.images].filter(i => i.currentSrc.startsWith('data:')).length },
        controls: controls.map(e => { const r=e.getBoundingClientRect(); return {
          text: (e.getAttribute('aria-label') || e.textContent).trim(), left:r.left, right:r.right,
          checked: e.querySelector('input[type=checkbox]')?.checked, disabled:e.disabled
        }; })
      };
    })()`);
    report.mobileViews.push({ name, requestedWidth: width, available: evidence.controls.length > 0, ...evidence });
    check(`${name} ${width}px has no horizontal overflow`, evidence.width === width && Math.max(evidence.scrollWidth, evidence.bodyScrollWidth) <= width + 1, evidence);
    if (controlsExpression !== '[]' && (!optional || evidence.controls.length)) {
      check(`${name} ${width}px controls fit horizontally`, evidence.controls.length > 0 && evidence.controls.every(e => e.left >= -1 && e.right <= width + 1), evidence.controls);
    }
    await snapshot(`${name}-${width}`);
    await shot(`${name}-${width}`, true);
  }
}
function connection(kind = 'untested') {
  const at = '2026-11-01T12:00:00.000Z';
  const success = kind === 'success';
  const tested = kind !== 'untested';
  return { kind: success ? 'test_succeeded' : tested ? 'connection_error' : 'configured_untested', label: success ? '最近一次连接测试成功' : tested ? '最近一次连接测试未通过' : '已填写配置，尚未完成测试', detail: success ? '同一次测试的文字与合成图片检查均通过；仅为能力冒烟测试，不代表真实照片语义理解已验证。' : tested ? '文字与图片尚未同时通过；未执行的项目不视为成功。' : '字段完整不代表连接可用。文字与合成图片分别测试，外发计入预算。', missing: [], issues: [], lastTestAt: tested ? at : null, lastTestOk: tested ? success : null, lastTestErrorClass: tested && !success ? 'invalid_response' : null, canTest: true, capabilities: { text: { state: tested ? 'succeeded' : 'untested', at: tested ? at : null, message: tested ? '固定文字响应测试通过。' : null }, vision: { state: success ? 'succeeded' : tested ? 'failed' : 'untested', at: tested ? at : null, message: success ? '合成图片颜色测试通过；不代表真实照片语义理解已验证。' : tested ? '模型返回内容未通过本项能力测试。' : null } } };
}
async function setup() {
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${OUT}/chrome-profile`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--window-size=1440,1000', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  const endpoint = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Own Chrome DevTools endpoint not found')), 20000);
    chrome.on('error', reject);
    chrome.stderr.on('data', d => { stderr += d; const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
  });
  const ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('Chrome CDP WebSocket open timed out after 20000ms')); ws.close(); }, 20000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Chrome CDP WebSocket open failed')); }, { once: true });
    ws.addEventListener('close', () => { clearTimeout(timer); reject(new Error('Chrome CDP WebSocket closed before open')); }, { once: true });
  });
  browser = new CDP(ws);
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId: page } = await browser.send('Target.attachToTarget', { targetId, flatten: true }));
  browser.on('Runtime.consoleAPICalled', (p, sid) => { if (sid === page) report.console.push({ type: p.type, args: p.args.map(a => a.value ?? a.description), at: p.timestamp }); });
  browser.on('Runtime.exceptionThrown', (p, sid) => { if (sid === page) report.failures.push({ uncaught: p.exceptionDetails }); });
  browser.on('Log.entryAdded', p => { report.console.push(p.entry); });
  browser.on('Network.requestWillBeSent', (p, sid) => { if (sid === page) report.network.push({ type: 'request', id: p.requestId, url: p.request.url, method: p.request.method, headers: p.request.headers, postData: p.request.postData, initiator: p.initiator.type }); });
  browser.on('Network.responseReceived', (p, sid) => { if (sid === page) report.network.push({ type: 'response', id: p.requestId, url: p.response.url, status: p.response.status, mime: p.response.mimeType }); });
  browser.on('Network.loadingFailed', (p, sid) => { if (sid === page) report.network.push({ type: 'failed', ...p }); });
  browser.on('Network.requestWillBeSentExtraInfo', (p, sid) => { if (sid === page) report.network.push({ type: 'wire-headers', id: p.requestId, headers: p.headers }); });
  browser.on('Network.loadingFinished', async (p, sid) => {
    const response = report.network.find(e => e.type === 'response' && e.id === p.requestId);
    if (sid === page && response?.status >= 400) {
      try { const body = await send('Network.getResponseBody', { requestId: p.requestId }); response.body = body.body; } catch (e) { response.bodyUnavailable = String(e); }
    }
  });
  browser.on('Browser.downloadWillBegin', p => { report.downloads.push(p); });
  browser.on('Browser.downloadProgress', p => { report.downloads.push(p); });
  browser.on('Fetch.requestPaused', async (p, sid) => {
    const url = new URL(p.request.url);
    const fulfil = async (body, status = 200) => browser.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: status, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') }, sid);
    if (/^\/api\/ai\/connection-test\/?$/.test(url.pathname)) {
      ++testPosts;
      report.interceptions.push({ url: p.request.url, method: p.request.method, body: p.request.postData, reply: readOnly ? 'blocked-readonly' : testReply, sequence: testPosts });
      // Every connection-test request is fulfilled locally, never forwarded, including unexpected calls.
      if (readOnly) {
        report.failures.push({ blockedReadOnlyRequest: p.request.url, method: p.request.method });
        return fulfil({ error: { message: 'Production read-only verification blocks connection probes.' } }, 403);
      }
      await delay(450);
      return testReply === 'http-error' ? fulfil({ error: { message: '固定模拟：连接测试暂时不可用。' } }, 503) : fulfil({ connection: connection(testReply) });
    }
    // Allow harmless prefetches and status/settings reads; block all writes plus export/probe action APIs.
    if (readOnly && (!['GET', 'HEAD', 'OPTIONS'].includes(p.request.method)
      || (url.pathname.startsWith('/api/') && /\/(?:seed|export|exports|probe|generate|generation)(?:\/|$)/.test(url.pathname))
      || (['http:', 'https:'].includes(url.protocol) && url.origin !== BASE))) {
      const blocked = { blockedReadOnlyRequest: p.request.url, method: p.request.method };
      report.interceptions.push(blocked);
      report.failures.push(blocked);
      return browser.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, sid);
    }
    if (url.pathname === '/api/ai/status' && scenario) {
      ++statusHits;
      report.interceptions.push({ url: p.request.url, scenario, sequence: statusHits });
      if (scenario === 'status-error' && statusHits === 1) return fulfil({ error: { message: '固定模拟：状态加载失败。' } }, 503);
      return fulfil({ defaultMode: 'ai', connection: connection() });
    }
    const runId = url.pathname.match(/^\/api\/exhibitions\/([^/]+)\/runs\//)?.[1];
    if (runId && p.request.method === 'POST' && !demoIds.has(runId)) {
      report.failures.push({ blockedNonDemoRun: p.request.url });
      return fulfil({ error: { message: 'Browser verification blocks non-demo generation.' } }, 403);
    }
    if (['http:', 'https:'].includes(url.protocol) && !['localhost', '127.0.0.1'].includes(url.hostname)) {
      report.interceptions.push({ blockedExternal: p.request.url });
      return browser.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, sid);
    }
    // The demo ID is learned from the route before the UI's autostart effect runs.
    const routeId = url.pathname.match(/^\/e\/([^/]+)\/material$/)?.[1];
    if (routeId && url.searchParams.get('autostart') === '1') demoIds.add(routeId);
    return browser.send('Fetch.continueRequest', { requestId: p.requestId }, sid);
  });
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Log.enable');
  if (readOnly) await send('Network.setBypassServiceWorker', { bypass: true });
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  await browser.send('Browser.setDownloadBehavior', { behavior: readOnly ? 'deny' : 'allow', downloadPath: OUT.replaceAll('/', '\\'), eventsEnabled: true });
  await desktop();
}
function mutationRequests() { return report.network.filter(e => e.type === 'request' && !['GET', 'HEAD', 'OPTIONS'].includes(e.method)); }
async function aiChecks() {
  await navigate(`${BASE}/create`);
  await wait(`Boolean(${find('AI')})`, 'create hydrated');
  await click('AI 使用说明与连接状态');
  await wait(`document.body.innerText.includes('AI 未配置')`, 'real missing configuration');
  const missing = await snapshot('01-create-ai-missing');
  check('AI default, unchecked consent, missing config/test disabled', missing.buttons.find(b => b.text === 'AI')?.pressed === 'true' && missing.inputs.filter(i => i.type === 'checkbox')[1]?.checked === false && missing.buttons.find(b => b.text === '测试模型连接')?.disabled === true, missing);
  await shot('01-create-ai-missing-desktop', true);
  await mobileViews('02-create-consent-mobile', consentControls);
  await desktop();
  // Fresh document removes all status overrides; this new document gets an explicit one-shot failure.
  await navigate(`${BASE}/create?browser=status-retry`, 'status-error');
  await click('AI 使用说明与连接状态');
  await wait(`document.body.innerText.includes('无法加载 AI 连接状态')`, 'status failure');
  await click('演示');
  await shot('03-status-load-error', true);
  await click('重新加载状态');
  await wait(`document.body.innerText.includes('已填写配置，尚未完成测试')`, 'status retry');
  check('Explicit Demo persists through status error/retry refresh', await js(`(${find('演示')}).getAttribute('aria-pressed') === 'true'`), { statusHits, ...(await snapshot('04-demo-status-retried')) });
  const beforePosts = mutationRequests().length;
  const origin = await js('performance.timeOrigin');
  await toggleLabel('我确认仅测试两个固定探测');
  const count = testPosts;
  testReply = 'partial';
  const expr = find('测试模型连接');
  await js(`(() => { const b=${expr}; b.click(); b.click(); })()`);
  await wait(`document.body.innerText.includes('文本探测通过不代表视觉可用')`, 'partial response');
  const partial = await snapshot('05-simulated-partial');
  check('Double click single intercepted POST; no parent form submit', testPosts - count === 1 && mutationRequests().slice(beforePosts).every(e => e.url.endsWith('/api/ai/connection-test')) && await js(`location.pathname === '/create' && performance.timeOrigin === ${origin}`), { calls: testPosts - count, writes: mutationRequests().slice(beforePosts), timeOrigin: origin });
  check('Text-only result honestly reports failed vision', partial.text.includes('文本探测：通过') && partial.text.includes('视觉探测：未通过') && !partial.text.includes('文本与视觉探测均已通过'), { simulated: true, text: partial.text });
  await shot('05-simulated-partial', true);
  testReply = 'http-error';
  await toggleLabel('我确认仅测试两个固定探测'); await click('测试模型连接');
  await wait(`document.body.innerText.includes('固定模拟：连接测试暂时不可用')`, 'connection request failure');
  check('Failed connection request requires fresh confirmation', await js(`(${find('重试连接测试')}).disabled && ![...document.querySelectorAll('label')].find(e=>e.textContent.includes('我确认仅测试两个固定探测')).querySelector('input').checked`), { simulated: true });
  await shot('06-simulated-test-error', true);
  testReply = 'success';
  await toggleLabel('我确认仅测试两个固定探测'); await click('重试连接测试');
  await wait(`document.body.innerText.includes('文本与视觉探测均已通过')`, 'full response');
  check('Simulated full success, capability disclaimers shown', await js(`document.body.innerText.includes('视觉探测：通过') && document.body.innerText.includes('不代表真实照片语义理解已验证')`), { simulated: true, calls: testPosts });
  await shot('07-simulated-test-success', true);
  check('Independent create UI actions preserve timeOrigin', origin === await js('performance.timeOrigin'), { before: origin, after: await js('performance.timeOrigin') });
  await navigate(`${BASE}/create`);
  await wait(`Boolean(${find('AI')}) && (${find('AI')}).getAttribute('aria-pressed') === 'true'`, 'real AI form again');
  await click('AI 使用说明与连接状态');
  await wait(`document.body.innerText.includes('AI 未配置')`, 'client status loaded before form submission');
  await click('创建并上传照片');
  await wait(`location.pathname.endsWith('/material') && document.body.innerText.includes('当前：AI 模式')`, 'AI material creation');
  const id = await js(`location.pathname.split('/')[2]`); report.aiExhibitionId = id;
  check('Unconfigured AI create allowed; material remains blocked', await js(`document.body.innerText.includes('AI 分析尚不可用') && (${find('分析照片并推荐选片')}).disabled`), { id, url: await js('location.href') });
  const { root } = await send('DOM.getDocument');
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId, files: [`${ROOT}/public/demo/photos/p01.jpg`] });
  await wait(`document.body.innerText.includes('p01.jpg') && document.querySelector('img[src*="/api/files/"]')`, 'fixture uploaded using file input');
  check('Actual upload allowed by same-origin guard; analysis disabled', await js(`(${find('分析照片并推荐选片')}).disabled`), { id, fixture: 'built-in p01.jpg' });
  await toggleLabel('允许把压缩分析图');
  await wait(`!document.body.innerText.includes('未授权：') && !document.body.innerText.includes('保存设置中')`, 'grant consent persisted');
  check('Grant without real config does not enable analysis', await js(`(${find('分析照片并推荐选片')}).disabled`), await js(`({checked:document.querySelector('#ai-settings input').checked})`));
  await toggleLabel('允许把压缩分析图');
  await wait(`document.body.innerText.includes('未授权：') && !document.body.innerText.includes('保存设置中')`, 'revoke persisted');
  await toggleLabel('允许把压缩分析图');
  await wait(`!document.body.innerText.includes('未授权：') && !document.body.innerText.includes('保存设置中')`, 'grant before switching');
  await click('切换为本地演示');
  await wait(`document.body.innerText.includes('当前：本地演示') && !document.body.innerText.includes('保存设置中')`, 'demo persisted');
  check('Switch to demo enables local analysis with photo', await js(`!(${find('分析照片并推荐选片')}).disabled`), { id });
  await click('切换为AI 模式');
  await wait(`document.body.innerText.includes('当前：AI 模式') && document.body.innerText.includes('未授权：') && !document.body.innerText.includes('保存设置中')`, 'switch back revokes consent');
  check('Switch back to AI clears prior consent and blocks analysis', await js(`!document.querySelector('#ai-settings input').checked && (${find('分析照片并推荐选片')}).disabled`), { id });
  const materialUrl = await js('location.href');
  await navigate(materialUrl);
  await wait(`document.body.innerText.includes('当前：AI 模式') && document.body.innerText.includes('未授权：')`, 'settings persist after reload');
  check('Mode and revoked consent persist after reload', true, { id });
  check('No automatic generation/connection POST from create, upload, mode, consent', mutationRequests().filter(e => e.url.includes(id) && e.url.includes('/runs/')).length === 0 && testPosts === 3, { connectionTests: testPosts, writes: mutationRequests().filter(e => e.url.includes(id)) });
  await shot('08-ai-material-desktop', true);
  await mobileViews('09-ai-material-consent-mobile', consentControls); await desktop();
  await snapshot('08-ai-material-final');
  await crossOriginCheck();
}
async function materialGateChecks() {
  const id = process.argv[3];
  if (!/^exh_[a-zA-Z0-9_-]+$/.test(id || '')) throw new Error('Explicit isolated AI test ID required');
  const url = `${BASE}/e/${id}/material`;
  await navigate(url, 'configured-display');
  await wait(`document.body.innerText.includes('当前：AI 模式') && document.body.innerText.includes('未授权：')`, 'AI material consent absent');
  await click('AI 使用说明与连接状态');
  await wait(`document.body.innerText.includes('已填写配置，尚未完成测试')`, 'mock configured status ready');
  check('Simulated usable config without consent keeps analysis disabled', await js(`(${find('分析照片并推荐选片')}).disabled`), { id, statusSimulated: true });
  await toggleLabel('允许把压缩分析图');
  await wait(`!document.body.innerText.includes('保存设置中') && !document.body.innerText.includes('未授权：') && !(${find('分析照片并推荐选片')}).disabled`, 'config plus consent enables button');
  check('Config display plus actual consent enables analysis button only', true, { id, statusSimulated: true, generationNotClicked: true });
  await shot('21-config-consent-enabled', true);
  await toggleLabel('允许把压缩分析图');
  await wait(`document.body.innerText.includes('未授权：') && !document.body.innerText.includes('保存设置中') && (${find('分析照片并推荐选片')}).disabled`, 'revoke disables button');
  check('Revoke immediately disables analysis with usable config display', true, { id });
  await navigate(url);
  await wait(`document.body.innerText.includes('当前：AI 模式')`, 'real status reset');
  await click('AI 使用说明与连接状态');
  await wait(`document.body.innerText.includes('AI 未配置')`, 'interception removed on navigation');
  check('Navigation removes status simulation and shows real missing config', true, { id });
  await shot('22-real-status-restored', true);
  const writes = mutationRequests();
  check('Config/consent gate actions trigger no model or generation requests', testPosts === 0 && writes.every(e=>e.url.endsWith('/external-ai')), { writes });
  const db = new DatabaseSync(`${DATA}/afterlight.db`, { readOnly: true });
  try {
    const counts = { ai_calls: db.prepare('SELECT COUNT(*) AS n FROM ai_calls').get().n, ai_budget_counters: db.prepare('SELECT COUNT(*) AS n FROM ai_budget_counters').get().n };
    check('Isolated DB has zero AI calls and budget reservations after all browser checks', counts.ai_calls === 0 && counts.ai_budget_counters === 0, counts);
  } finally { db.close(); }
  await snapshot('22-material-gates-final');
}
function dbDigest() {
  const db = new DatabaseSync(`${DATA}/afterlight.db`, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const values = tables.map(({ name }) => ({ name, rows: db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() }));
    return { sha256: createHash('sha256').update(JSON.stringify(values)).digest('hex'), counts: values.map(v => [v.name, v.rows.length]) };
  } finally { db.close(); }
}
async function crossOriginCheck() {
  const before = dbDigest();
  const mark = report.network.length;
  const response = await js(`fetch('http://127.0.0.1:3000/api/exhibitions',{method:'POST',mode:'no-cors',headers:{'Content-Type':'text/plain'},body:JSON.stringify({title:'MUST NOT BE CREATED - cross origin browser check',mode:'demo'})}).then(r=>({type:r.type,status:r.status})).catch(e=>({error:String(e)}))`);
  await wait(`document.readyState === 'complete'`, 'page remains usable');
  const after = dbDigest();
  const wire = report.network.slice(mark).filter(e => e.url?.includes('127.0.0.1:3000/api/exhibitions'));
  check('Actual cross-origin POST rejected 403 with unchanged DB', wire.some(e => e.type === 'response' && e.status === 403) && before.sha256 === after.sha256, { browserResponse: response, wire, before, after });
}
async function demoChecks() {
  await navigate(BASE + '/');
  await wait(`Boolean(${find('先看一个例子')})`, 'home demo seed');
  await shot('10-home-before-demo');
  await click('先看一个例子');
  await wait(`location.pathname.includes('/e/')`, 'demo route');
  const id = await js(`location.pathname.split('/')[2]`); demoIds.add(id); report.demoExhibitionId = id;
  await mobileViews('10-analysis-progress-mobile', progressControls, { optional: true }); await desktop();
  await wait(`location.pathname.endsWith('/selection') && Boolean(${find('确认选片，发现主题 →')})`, 'demo autostart to selection', 150000);
  check('Home demo seed autostarts and reaches selection', true, { id });
  await snapshot('11-selection'); await shot('11-selection-desktop', true);
  await mobileViews('11-selection-batch-mobile', `[...document.querySelectorAll('button')].filter(e => /批量|全选|全不选|全部|取消|清空|推荐|暂缓/.test(e.getAttribute('aria-label') || e.textContent))`); await desktop();
  await click('确认选片，发现主题 →');
  const hold = await js(`Boolean(${find('本次先不使用暂缓照片')})`);
  if (hold) await click('本次先不使用暂缓照片');
  await mobileViews('12-motif-progress-mobile', progressControls, { optional: true }); await desktop();
  await wait(`location.pathname.endsWith('/motifs') && Boolean(${find('选为主线')})`, 'motifs discovered', 150000);
  await snapshot('12-motifs'); await shot('12-motifs-desktop', true);
  await click('选为主线');
  await wait(`Boolean(${find('用这个主题生成影展')}) && !(${find('用这个主题生成影展')}).disabled`, 'motif saved');
  await click('用这个主题生成影展');
  await mobileViews('13-running-generation-mobile', progressControls, { optional: true }); await desktop();
  await wait(`(location.pathname.endsWith('/narrative') || location.pathname.endsWith('/layout')) && !document.body.innerText.includes('影展正在生成')`, 'generated route', 180000);
  await mobileViews('13-generated-progress-mobile', progressControls, { optional: true }); await desktop();
  await snapshot('13-narrative-or-layout');
  if (await js(`location.pathname.endsWith('/narrative')`)) {
    await wait(`Boolean(${find('确认内容，查看版式 →')}) && !(${find('确认内容，查看版式 →')}).disabled`, 'narrative ready', 180000);
    await shot('13-narrative-desktop', true);
    await click('确认内容，查看版式 →');
  }
  await wait(`location.pathname.endsWith('/layout') && Boolean(${find('一键放映 ▶')})`, 'layout ready', 180000);
  check('Selection confirm -> motif choose -> narrative -> layout succeeds', true, { id, url: await js('location.href') });
  await finishDemo(id);
}
async function resumeDemoChecks() {
  const id = process.argv[3];
  if (!/^exh_[a-zA-Z0-9_-]+$/.test(id || '')) throw new Error('Explicit isolated demo ID required');
  await navigate(`${BASE}/e/${id}/layout`);
  await wait(`Boolean(${find('一键放映 ▶')}) && document.querySelector('iframe')`, 'existing demo layout loaded');
  const status = await js(`fetch('/api/exhibitions/${id}/status').then(r=>r.json())`);
  if (status.exhibition?.mode !== 'demo' || !status.exhibition?.is_demo_set) throw new Error('Refusing non-demo resume');
  demoIds.add(id); report.demoExhibitionId = id;
  await finishDemo(id);
}
async function sampleStableOrigin(name, includeFrame = false) {
  const samples = [];
  // Baseline plus two bounded idle observations; this is not a continuous-playback test.
  for (let i = 0; i < 3; ++i) {
    if (i) await delay(2000);
    samples.push(await js(`(() => {
      const frame = ${includeFrame} ? document.querySelector('iframe')?.contentDocument : null;
      return { url:location.href, timeOrigin:performance.timeOrigin, visibility:document.visibilityState,
        frame:frame ? { url:frame.URL, timeOrigin:frame.defaultView.performance.timeOrigin,
          loadedImages:[...frame.images].filter(i => i.complete && i.naturalWidth > 0).length } : null };
    })()`));
  }
  const baseline = samples[0];
  const evidence = { name, samples, intervalMs: 2000, observationWindowMs: 4000, note: 'Idle document stability only; no claim of continuous playback, especially while hidden.' };
  report.origins.push(evidence);
  check(`${name} timeOrigin is stable across two idle samples`, samples.every(s => s.url === baseline.url && s.timeOrigin === baseline.timeOrigin
    && (!includeFrame || (s.frame?.loadedImages > 0 && s.frame.url === baseline.frame?.url && s.frame.timeOrigin === baseline.frame?.timeOrigin))), evidence);
}
async function productionReadOnlyChecks() {
  // No seeding, status/config assumptions, DB reads, exports or write-capable API calls.
  report.readOnlyExhibitionId = exhibitionId;
  await navigate(`${BASE}/`);
  await wait(`Boolean(${find('先看一个例子')})`, 'read-only homepage loaded');
  await snapshot('30-readonly-home'); await shot('30-readonly-home');
  await sampleStableOrigin('Read-only initial homepage');

  const layoutUrl = `${BASE}/e/${exhibitionId}/layout`;
  const homeLink = `[...document.querySelectorAll('a')].find(e => ${visible} && e.href === ${JSON.stringify(layoutUrl)})`;
  const fromHomeLink = await js(`Boolean(${homeLink})`);
  if (fromHomeLink) await js(`(${homeLink}).click()`);
  else await navigate(layoutUrl); // The explicit existing ID need not be listed on the homepage.
  await wait(`location.pathname === '/e/${exhibitionId}/layout' && Boolean(${find('一键放映 ▶')}) && (() => {
    const frame = document.querySelector('iframe')?.contentDocument;
    return frame?.readyState === 'complete' && [...frame.images].some(i => i.complete && i.naturalWidth > 0);
  })()`, 'read-only existing layout with a loaded iframe image');
  check('Read-only homepage -> existing layout loads an iframe image', true, { exhibitionId, fromHomeLink, url: await js('location.href') });
  await snapshot('31-readonly-layout'); await shot('31-readonly-layout', true);
  await sampleStableOrigin('Read-only layout and iframe', true);

  await click('一键放映 ▶');
  await wait(`location.pathname === '/exhibition/${exhibitionId}' && document.querySelector('.playback-bar') && [...document.images].some(i => i.complete && i.naturalWidth > 0)`, 'read-only browse with loaded image');
  await wait(`Boolean(${find('暂停')}) || Boolean(${find('继续')}) || Boolean(${find('开始放映')})`, 'read-only playback controls ready');
  await snapshot('32-readonly-browse'); await shot('32-readonly-browse');
  await sampleStableOrigin('Read-only browse');
  await mobileViews('33-readonly-browse-playback-mobile', playbackControls);
  await click('更多 ▾');
  await click('← 返回首页');
  await wait(`location.pathname === '/' && Boolean(${find('先看一个例子')})`, 'read-only return home');
  await desktop();
  await snapshot('34-readonly-return-home'); await shot('34-readonly-return-home');
  await sampleStableOrigin('Read-only returned homepage');
  check('Read-only browse -> homepage works', true, { url: await js('location.href') });

  const writes = mutationRequests();
  const blocked = report.interceptions.filter(e => e.blockedReadOnlyRequest);
  check('Production read-only has no write, export or probe attempts', writes.length === 0 && blocked.length === 0 && testPosts === 0 && report.downloads.length === 0, { writes, blocked, connectionTests: testPosts, downloads: report.downloads });
  const consoleErrors = report.console.filter(e => e.type === 'error' || e.level === 'error');
  const networkErrors = report.network.filter(e => (e.type === 'response' && e.status >= 400) || (e.type === 'failed' && !e.canceled && e.errorText !== 'net::ERR_ABORTED'));
  const knownFavicon = e => e.url === `${BASE}/favicon.ico` && (e.status === 404 || (e.source === 'network' && e.text?.includes('404')));
  const unexpectedConsoleErrors = consoleErrors.filter(e => !knownFavicon(e));
  const unexpectedNetworkErrors = networkErrors.filter(e => !knownFavicon(e));
  report.knownResourceErrors = [...consoleErrors, ...networkErrors].filter(knownFavicon);
  check('Production read-only has no application errors (known favicon 404 recorded separately)', unexpectedConsoleErrors.length === 0 && unexpectedNetworkErrors.length === 0 && report.failures.length === 0, { unexpectedConsoleErrors, unexpectedNetworkErrors, knownResourceErrors: report.knownResourceErrors, failures: [...report.failures] });
}
async function finishDemo(id) {
  await snapshot('14-layout'); await shot('14-layout-desktop', true);
  await mobileViews('14-layout-generated-mobile', progressControls, { optional: true }); await desktop();
  for (const [format, label] of [['html', '导出 HTML'], ['json', '结构数据（高级导出）']]) {
    const mark = report.network.length;
    await click(label);
    try {
      await waitForFile(`afterlight-${id}.${format}`, mark);
      check(`UI ${format.toUpperCase()} export downloads`, true, { file: `${OUT}/afterlight-${id}.${format}` });
    } catch (e) {
      check(`UI ${format.toUpperCase()} export downloads`, false, { error: String(e), network: report.network.slice(mark).filter(e=>e.url?.includes('/export')) });
      await snapshot(`export-${format}-failed`); await shot(`export-${format}-failed`, true);
    }
  }
  await click('一键放映 ▶');
  await wait(`location.pathname === '/exhibition/${id}' && document.querySelector('.playback-bar') && document.querySelector('img')`, 'browse exhibition');
  await wait(`Boolean(${find('暂停')}) || Boolean(${find('继续')}) || Boolean(${find('开始放映')})`, 'playback controls ready');
  const origin = await js('performance.timeOrigin');
  if (await js(`Boolean(${find('暂停')})`)) await click('暂停');
  await click('下一段');
  const mid = await js('performance.timeOrigin');
  await click('上一段');
  const after = await js('performance.timeOrigin');
  const browse = await snapshot('15-browse');
  check('Browse independent next/previous actions preserve timeOrigin', origin === mid && mid === after, { origin, mid, after, visibility: browse.visibility, note: 'No claim of full continuous playback.' });
  await js('window.scrollTo(0,0)'); await shot('15-browse-desktop');
  await mobileViews('16-browse-playback-mobile', playbackControls);
  await click('更多 ▾');
  await mobileViews('17-browse-menu-mobile', `[...document.querySelectorAll('button,a')].filter(e => /返回首页|退出|全屏|放映|暂停|继续|上一段|下一段/.test(e.textContent))`);
  await click('← 返回首页');
  await wait(`location.pathname === '/' && Boolean(${find('先看一个例子')})`, 'return home');
  check('Browse return home works', true, { url: await js('location.href') });
  await mobileViews('18-return-home-mobile'); await desktop();
  const status = await js(`fetch('/api/exhibitions/${id}/status').then(r=>r.json())`);
  check('Demo remains demo and does not call model connection-test', status.exhibition?.mode === 'demo' && testPosts === (phase === 'all' ? 3 : 0), { mode: status.exhibition?.mode, allow_external_ai: status.exhibition?.allow_external_ai, runs: status.runs?.map(r=>({agent:r.agent_type,status:r.status,source:r.source})), testPosts });
  if (existsSync(`${OUT}/afterlight-${id}.html`)) await offlineCheck(id);
  else check('Offline HTML verification', false, { blockedBy: 'UI HTML export failed; no generated file to open.' });
}
async function waitForFile(name, networkMark = 0) {
  const start = Date.now();
  while (Date.now() - start < 90000) {
    if ((await readdir(OUT)).includes(name)) return;
    const failed = report.network.slice(networkMark).find(e=>e.type==='response' && e.url.includes('/export') && e.status>=400);
    if (failed) throw new Error(`Export HTTP ${failed.status}: ${failed.body || failed.url}`);
    await delay(250);
  }
  throw new Error(`Download missing: ${name}`);
}
async function offlineCheck(id) {
  const path = `${OUT}/afterlight-${id}.html`;
  const html = await readFile(path, 'utf8');
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  const mark = report.network.length;
  await navigate(pathToFileURL(path).href);
  await wait(`document.images.length > 0`, 'offline image elements');
  const imageCount = await js('document.images.length');
  for (let i = 0; i < imageCount; ++i) {
    await js(`document.images[${i}].scrollIntoView({block:'center',behavior:'instant'})`);
    await wait(`document.images[${i}].complete && document.images[${i}].naturalWidth > 0`, `offline lazy image ${i + 1}/${imageCount}`, 15000);
  }
  await js(`window.scrollTo({top:0,behavior:'instant'})`);
  await wait(`[...document.images].every(i => i.complete && i.naturalWidth > 0)`, 'all offline images after scrolling');
  const before = await snapshot('19-offline-html');
  check('Local exported HTML offline images load with no HTTP/API dependency', !report.network.slice(mark).some(e=>e.type==='request' && /^https?:/.test(e.url)) && await js('[...document.images].every(i=>i.currentSrc.startsWith("data:") && i.naturalWidth>0)'), { file: path, images: await js('document.images.length'), bytes: Buffer.byteLength(html), buttons: before.buttons, network: report.network.slice(mark) });
  await shot('19-offline-html-desktop');
  await click('开始放映', { exact: false });
  await wait(`document.body.innerText.includes('暂停')`, 'offline playback start');
  await click('下一段', { exact: false });
  await click('上一段', { exact: false });
  const after = await js('({url:location.href,timeOrigin:performance.timeOrigin,visibility:document.visibilityState})');
  check('Offline playback controls preserve the document', before.timeOrigin === after.timeOrigin, { before: before.timeOrigin, after, note: 'Start/next/previous controls only; no claim of continuous playback while hidden.' });
  if (await js(`Boolean(${find('暂停', 'button', false)})`)) await click('暂停', { exact: false });
  const viewMark = report.mobileViews.length;
  await mobileViews('20-offline-html-controls-mobile', `[...document.querySelectorAll('button,a')].filter(e => /开始放映|暂停|继续|上一段|下一段|全屏|更多/.test(e.textContent))`);
  const mobileEvidence = report.mobileViews.slice(viewMark);
  check('Offline HTML embedded images remain loaded at 360px and 390px without HTTP requests', mobileEvidence.every(v => v.images.total > 0 && v.images.loaded === v.images.total && v.images.embedded === v.images.total)
    && !report.network.slice(mark).some(e => e.type === 'request' && /^https?:/.test(e.url)), { views: mobileEvidence, network: report.network.slice(mark) });
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
}
try {
  await setup();
  if (phase === 'ai' || phase === 'all') await aiChecks();
  if (phase === 'demo' || phase === 'all') await demoChecks();
  if (phase === 'resume-demo') await resumeDemoChecks();
  if (phase === 'material-gates') await materialGateChecks();
  if (readOnly) await productionReadOnlyChecks();
} catch (error) {
  report.failures.push({ error: error.stack || String(error) });
  console.error(error);
  try { await snapshot('failure'); await shot('failure', true); } catch { /* keep original evidence */ }
  process.exitCode = 1;
} finally {
  report.summary = { passed: report.checks.filter(c=>c.pass).length, failed: report.checks.filter(c=>!c.pass).length, exceptions: report.failures.length, connectionTestsIntercepted: testPosts, consoleErrors: report.console.filter(c=>c.type==='error'||c.level==='error').length, failedHttp: report.network.filter(e=>e.type==='response' && e.status>=400) };
  await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  console.log(`REPORT ${OUT}/report.json`); console.log(JSON.stringify(report.summary));
  if (report.checks.some(c=>!c.pass) || report.failures.length) process.exitCode = 1;
  closing = true;
  if (browser) {
    try { await browser.send('Browser.close'); } catch { /* CDP may already be closed or timed out. */ }
    finally { browser.ws.close(); }
  }
  if (chrome && chrome.exitCode === null) chrome.kill();
}

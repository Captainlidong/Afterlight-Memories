import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nextCli = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
assert.ok(process.argv.includes('--production-stopped'), 'Stop this project’s dev/start processes before rebuilding .next; then pass --production-stopped');
const output = await mkdtemp(path.join(os.tmpdir(), 'afterlight-stage-g-'));
const data = path.join(output, 'data');
await mkdir(data);
const fakeKey = `stage-g-fake-${randomUUID()}`;
const needles = [...new Set([
  fakeKey,
  Buffer.from(fakeKey).toString('base64'),
  Buffer.from(`Bearer ${fakeKey}`).toString('base64'),
  [...fakeKey].map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''),
])].map(s => Buffer.from(s));
const overlap = Math.max(...needles.map(n => n.length)) - 1;
const report = { startedAt: new Date().toISOString(), output, checks: [], leaks: [], surfaces: [], providerRequests: [], errors: [] };
const logs = [];
const appDay = new Date().toISOString().slice(0, 10);
let upstreamMode = 'success';
let app;
let base;
let config;

function check(name, pass, evidence = {}) {
  report.checks.push({ name, pass: Boolean(pass), evidence });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
  assert.ok(pass, name);
}
function scan(label, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  report.surfaces.push({ label, bytes: bytes.length });
  if (needles.some(needle => bytes.includes(needle))) report.leaks.push(label);
}
function today() {
  assert.equal(new Date().toISOString().slice(0, 10), appDay, 'UTC day changed; repeat the isolated check without assuming a lifetime cap');
}
async function freePort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function child(args, env, label) {
  const process = spawn(globalThis.process.execPath, [nextCli, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  let done = false;
  process.stdout.on('data', b => chunks.push(b));
  process.stderr.on('data', b => chunks.push(b));
  const finished = new Promise((resolve, reject) => {
    process.once('error', error => { done = true; reject(error); });
    process.once('close', (code, signal) => { done = true; resolve({ code, signal }); });
  });
  finished.catch(() => {});
  return { process, finished, isDone: () => done, log: () => ({ label, value: Buffer.concat(chunks) }) };
}
async function stop(owned) {
  if (!owned) return;
  if (!owned.isDone()) owned.process.kill();
  const timeout = setTimeout(() => { if (!owned.isDone()) owned.process.kill('SIGKILL'); }, 10000);
  try { await owned.finished; } finally { clearTimeout(timeout); logs.push(owned.log()); }
}
async function startApp() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  app = child(['start', '--hostname', '127.0.0.1', '--port', String(port)], config, 'production-runtime');
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (app.isDone()) throw new Error('Isolated Next server exited before readiness');
    if (app.log().value.toString('utf8').includes('Ready in')) {
      const health = await request('/api/health');
      assert.equal(health.json.mode, 'ai');
      assert.equal(health.json.db, 'ok');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Isolated Next server readiness timed out');
}
async function request(route, { method = 'GET', body, expected = 200, origin = base } = {}) {
  const url = new URL(route, base);
  assert.equal(url.origin, base, 'Requests must stay on the isolated application');
  scan('application-request-url', url.href);
  const headers = { Origin: origin };
  let payload = body;
  if (body !== undefined && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const response = await fetch(url, { method, headers, body: payload, redirect: 'error', signal: AbortSignal.timeout(45000) });
  const text = await response.text();
  scan(`${method} ${route}:headers`, JSON.stringify([...response.headers]));
  scan(`${method} ${route}:body`, text);
  assert.equal(response.status, expected, `${method} ${route}: unexpected HTTP status`);
  return { text, json: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null };
}
const post = (route, body = {}, expected = 202) => request(route, { method: 'POST', body, expected });
async function waitRun(id, workflowId) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const { json } = await request(`/api/exhibitions/${id}/status`);
    if (!json.is_running && json.workflow_id === workflowId) return json;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Isolated workflow did not finish');
}
async function scanTree(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) await scanTree(file);
    else if (item.isFile()) {
      let carry = Buffer.alloc(0), bytes = 0, found = false;
      for await (const chunk of createReadStream(file)) {
        bytes += chunk.length;
        const combined = Buffer.concat([carry, chunk]);
        if (needles.some(needle => combined.includes(needle))) found = true;
        carry = combined.subarray(Math.max(0, combined.length - overlap));
      }
      const label = path.relative(root, file).replaceAll('\\', '/');
      report.surfaces.push({ label, bytes });
      if (found) report.leaks.push(label);
    }
  }
}
async function scanBrowser(routes) {
  const profile = path.join(output, 'chrome-profile');
  const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--window-size=1440,1000', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const chromeLog = [];
  chrome.stderr.on('data', b => chromeLog.push(b));
  const ended = new Promise((resolve, reject) => { chrome.once('close', resolve); chrome.once('error', reject); });
  ended.catch(() => {});
  let socket, page, sequence = 0;
  const pending = new Map(), blocked = [], failures = [];
  function send(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(page ? { sessionId: page } : {}) }));
    });
  }
  try {
    let address;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (chrome.exitCode !== null) throw new Error('Isolated Chrome exited before readiness');
      try { address = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(address, 'Isolated Chrome readiness timed out');
    socket = new WebSocket(`ws://127.0.0.1:${address[0]}${address[1]}`);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('CDP connection timed out')), 20000);
      socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('CDP connection failed')); }, { once: true });
    });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const job = pending.get(message.id);
        if (!job) return;
        pending.delete(message.id); clearTimeout(job.timer);
        if (message.error) job.reject(new Error('CDP command rejected')); else job.resolve(message.result);
      } else if (message.method === 'Fetch.requestPaused') {
        const { requestId, request: intercepted } = message.params;
        scan('browser-request-url', intercepted.url);
        const allowed = new URL(intercepted.url).origin === base && intercepted.method === 'GET';
        if (!allowed) blocked.push({ method: intercepted.method, url: intercepted.url });
        send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId, ...(!allowed ? { errorReason: 'BlockedByClient' } : {}) }).catch(() => failures.push('request interception failed'));
      } else if (['Runtime.consoleAPICalled', 'Runtime.exceptionThrown'].includes(message.method)) {
        scan(`browser:${message.method}`, JSON.stringify(message.params));
        if (message.method === 'Runtime.exceptionThrown') failures.push('browser runtime exception');
      }
    });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    page = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    for (const method of ['Page.enable', 'Runtime.enable', 'Fetch.enable']) await send(method);
    for (let i = 0; i < routes.length; i++) {
      const url = `${base}${routes[i]}`;
      await send('Page.navigate', { url });
      let ready = false;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const state = await send('Runtime.evaluate', { expression: `location.href === ${JSON.stringify(url)} && document.readyState === 'complete' && document.body.innerText.length > 40 && (!location.pathname.endsWith('/layout') || [...(document.querySelector('iframe')?.contentDocument?.images || [])].some(i => i.complete && i.naturalWidth > 0))`, returnByValue: true });
        if (state.result.value) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      assert.ok(ready, 'Browser page readiness timed out');
      const dom = await send('Runtime.evaluate', { expression: `JSON.stringify({ page: document.documentElement.outerHTML, frames: [...document.querySelectorAll('iframe')].map(f => f.contentDocument?.documentElement.outerHTML ?? null) })`, returnByValue: true });
      scan(`browser-DOM:${routes[i]}`, dom.result.value);
      if (routes[i].endsWith('/material')) {
        const text = await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
        check('Material page explains persistent job exhaustion without hiding saved results', text.result.value.includes('本影展任务总额不会因跨日、重试或重新生成而重置') && text.result.value.includes('已保存结果不受影响'));
      }
      const screenshot = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(path.join(output, `browser-${i}.png`), Buffer.from(screenshot.data, 'base64'));
    }
    check('Rendered pages and browser console contain no fake key', report.leaks.length === 0, { pages: routes.length });
    check('Browser scan performs only local reads without runtime exceptions', blocked.length === 0 && failures.length === 0, { blockedCount: blocked.length, failures });
  } finally {
    for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error('CDP closing')); }
    pending.clear();
    socket?.close();
    if (chrome.exitCode === null) chrome.kill();
    await ended;
    logs.push({ label: 'isolated-chrome', value: Buffer.concat(chromeLog) });
  }
}
const provider = createServer(async (req, res) => {
  let size = 0;
  for await (const chunk of req) size += chunk.length;
  const authorized = req.headers.authorization === `Bearer ${fakeKey}`;
  scan('mock-provider-request-url', req.url);
  report.providerRequests.push({ path: req.url, method: req.method, authorized, bytes: size, mode: upstreamMode });
  res.setHeader('Content-Type', 'application/json');
  if (!authorized || req.url !== '/v1/chat/completions') {
    res.statusCode = 403;
    res.end(JSON.stringify({ error: { message: 'Unexpected local mock request' } }));
  } else if (upstreamMode === 'auth-error') {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: { message: `Deliberate local-only leak payload: ${fakeKey}`, code: 'invalid_api_key' } }));
  } else {
    const content = report.providerRequests.length === 1 ? 'AFTERLIGHT_OK' : 'red';
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  }
});
try {
  await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  config = {
    ...process.env,
    AFTERLIGHT_DATA_DIR: data,
    AFTERLIGHT_MODE: 'ai',
    AFTERLIGHT_ACCESS_MODE: 'local',
    AFTERLIGHT_DEMO_DELAY: '0',
    AI_PROVIDER: 'openai-compatible',
    AI_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`,
    AI_API_KEY: fakeKey,
    AI_VISION_MODEL: 'stage-g-local-mock',
    AI_TEXT_MODEL: 'stage-g-local-mock',
    AI_MAX_CALLS_PER_DAY: '3',
    AI_MAX_CALLS_PER_JOB: '1',
    AI_CONNECTION_TEST_LIMIT_PER_HOUR: '20',
    AI_DAY_TIMEZONE: 'UTC',
    AI_MAX_RETRIES: '0',
    AI_MAX_CONCURRENCY: '1',
    AI_MAX_PHOTOS_PER_JOB: '4',
    AI_IMAGE_MAX_EDGE: '1280',
    AI_REQUEST_TIMEOUT_MS: '5000',
    AI_MAX_OUTPUT_TOKENS: '256',
    AI_CACHE_ENABLED: 'false',
    RATE_LIMIT_ENABLED: 'true',
    RATE_LIMIT_TASKS_PER_IP_PER_MINUTE: '2',
    RATE_LIMIT_TASKS_PER_IP_PER_DAY: '5',
    RATE_LIMIT_TASKS_PER_USER_PER_DAY: '5',
    NEXT_TELEMETRY_DISABLED: '1',
  };
  const build = child(['build'], config, 'production-build');
  const buildTimeout = setTimeout(() => build.process.kill(), 300000);
  let result;
  try { result = await build.finished; } finally { clearTimeout(buildTimeout); logs.push(build.log()); }
  check('Production build with an ephemeral fake key succeeds', result.code === 0, result);
  await startApp();
  check('Security check uses a fresh isolated database', (await request('/api/exhibitions')).json.exhibitions.length === 0);
  for (const route of ['/', '/create', '/create?demo=1', '/about', '/api/ai/status']) await request(route);
  await request('/api/ai/connection-test', { method: 'POST', body: { confirmed: true }, expected: 403, origin: `http://localhost:${new URL(base).port}` });
  check('Different loopback Origin is still refused before any provider request', report.providerRequests.length === 0);
  today();
  const probe = (await post('/api/ai/connection-test', { confirmed: true }, 200)).json;
  check('Fake key reaches only the local mock Authorization header', report.providerRequests.length === 2 && report.providerRequests.every(r => r.authorized));
  check('Actual connection route completes fixed text and image probes', probe.connection.lastTestOk === true);

  const { id: aiId } = (await post('/api/exhibitions', { title: 'Stage G local security fixture', mode: 'ai', allow_external_ai: true }, 201)).json;
  report.aiExhibitionId = aiId;
  const form = new FormData();
  form.append('files', new Blob([await readFile(path.join(root, 'public/demo/photos/p01.jpg'))], { type: 'image/jpeg' }), 'built-in-fixture.jpg');
  const uploaded = await request(`/api/exhibitions/${aiId}/photos`, { method: 'POST', body: form, expected: 201 });
  check('Only the built-in fixture was uploaded to the isolated application', uploaded.json.uploaded === 1 && uploaded.json.failed === 0);
  upstreamMode = 'auth-error';
  today();
  const run = (await post(`/api/exhibitions/${aiId}/runs/ingest`, { request_id: randomUUID() })).json;
  const failed = await waitRun(aiId, run.workflow_id);
  check('Provider auth error fails the workflow without leaking its raw message', failed.exhibition.status === 'stage_failed' && failed.exhibition.failed_stage === 'ingest' && report.providerRequests.length === 3);
  await request(`/api/exhibitions/${aiId}/runs/${run.run_id}`);
  for (const route of [`/e/${aiId}/material`, `/api/exhibitions/${aiId}`, `/api/exhibitions/${aiId}/photos`]) await request(route);
  await request(`/api/exhibitions/${aiId}/export`, { method: 'POST', body: { format: 'json' } });
  today();
  const denied = (await post('/api/ai/connection-test', { confirmed: true }, 200)).json;
  check('Daily cap is shared by connection probes and workflow calls', denied.connection.lastTestOk === false && denied.connection.lastTestErrorClass === 'budget' && report.providerRequests.length === 3);
  const retry = (await post(`/api/exhibitions/${aiId}/runs/retry`, { request_id: randomUUID() })).json;
  const retried = await waitRun(aiId, retry.workflow_id);
  check('New retry workflow cannot escape the shared daily cap', retried.exhibition.status === 'stage_failed' && report.providerRequests.length === 3);
  await request(`/api/exhibitions/${aiId}/runs/${retry.run_id}`);

  const { id: demoId } = (await post('/api/demo/seed', {}, 201)).json;
  report.demoExhibitionId = demoId;
  const ingestion = (await post(`/api/exhibitions/${demoId}/runs/ingest`, { request_id: randomUUID() })).json;
  const selection = await waitRun(demoId, ingestion.workflow_id);
  assert.equal(selection.exhibition.status, 'awaiting_selection_confirm');
  const confirmed = (await post(`/api/exhibitions/${demoId}/curation/confirm`, { expected_revision: selection.exhibition.input_revision, hold_policy: 'exclude', discover_motifs: true, request_id: randomUUID() }, 200)).json;
  await waitRun(demoId, confirmed.workflow_id);
  const motifs = (await request(`/api/exhibitions/${demoId}/motifs`)).json.motifs;
  await post(`/api/exhibitions/${demoId}/motifs/select`, { motif_id: motifs[0].id }, 200);
  const narration = (await post(`/api/exhibitions/${demoId}/runs/narrative`, { request_id: randomUUID() })).json;
  const complete = await waitRun(demoId, narration.workflow_id);
  check('Demo still completes with fake AI configuration and exhausted AI budget', complete.progress.layout && complete.progress.qa && report.providerRequests.length === 3);
  for (const route of [`/e/${demoId}/layout`, `/exhibition/${demoId}`, `/api/exhibitions/${demoId}/preview`, `/api/ai/status`]) await request(route);
  for (const format of ['html', 'json']) {
    const exported = await request(`/api/exhibitions/${demoId}/export`, { method: 'POST', body: { format } });
    scan(`download.${format}`, exported.text);
    await writeFile(path.join(output, `afterlight.${format}`), exported.text);
    if (format === 'html') check('HTML export remains self-contained', exported.text.startsWith('<!doctype html>') && exported.text.includes('data:image/jpeg;base64,') && !exported.text.includes('/api/files/'));
  }
  await scanBrowser(['/create', `/e/${aiId}/material`, `/e/${demoId}/layout`]);
  await stop(app); app = null;
  await startApp();
  today();
  const restarted = (await post('/api/ai/connection-test', { confirmed: true }, 200)).json;
  check('Restart retains daily cap and does not send a fourth request', restarted.connection.lastTestErrorClass === 'budget' && report.providerRequests.length === 3);
  await stop(app); app = null;
  config.AI_MAX_CALLS_PER_DAY = '100';
  config.AI_MAX_CALLS_PER_JOB = '100';
  await startApp();
  const resumed = (await post(`/api/exhibitions/${aiId}/runs/retry`)).json;
  const resumedStatus = await waitRun(aiId, resumed.workflow_id);
  check('Frozen job cap blocks retries after restart even with increased daily and job configuration', resumedStatus.exhibition.status === 'stage_failed' && resumedStatus.runs.some(r => r.id === resumed.run_id && r.error_message?.includes('任务总额')) && report.providerRequests.length === 3);
  await request(`/api/exhibitions/${aiId}`, { method: 'PATCH', body: { mode: 'demo' } });
  await request(`/api/exhibitions/${aiId}`, { method: 'PATCH', body: { mode: 'ai' } });
  const consent = await request(`/api/exhibitions/${aiId}/external-ai`, { method: 'PATCH', body: { allow_external_ai: true } });
  assert.equal(consent.json.allow_external_ai, true);
  const reanalysis = (await post(`/api/exhibitions/${aiId}/runs/ingest`, { request_id: randomUUID() })).json;
  const reanalysisStatus = await waitRun(aiId, reanalysis.workflow_id);
  check('Mode changes and reanalysis do not reset the job budget', reanalysisStatus.exhibition.status === 'stage_failed' && reanalysisStatus.runs.some(r => r.id === reanalysis.run_id && r.error_message?.includes('任务总额')) && report.providerRequests.length === 3);
  await stop(app); app = null;

  const db = new DatabaseSync(path.join(data, 'afterlight.db'), { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    for (const { name } of tables) scan(`database:${name}`, JSON.stringify(db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()));
    const calls = db.prepare('SELECT COUNT(*) AS n FROM ai_calls').get().n;
    report.aiCalls = calls;
    const job = db.prepare('SELECT * FROM curation_jobs WHERE exhibition_id=?').get(aiId);
    const jobUsed = db.prepare("SELECT used FROM ai_budget_counters WHERE scope_type='job' AND scope_id=? AND period_key='total'").get(job.id).used;
    check('All AI workflows share one persistent job with the original limit and exact charged total', job.max_calls === 1 && jobUsed === 1 && db.prepare('SELECT COUNT(DISTINCT curation_job_id) AS n FROM curation_job_workflows').get().n === 1);
    check('Audit records match exactly three local mock requests', calls === 3 && report.providerRequests.length === 3);
    check('Isolated database integrity remains valid', db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok' && db.prepare('PRAGMA foreign_key_check').all().length === 0);
  } finally { db.close(); }
  await scanTree(path.join(root, '.next'));
  for (const entry of logs) scan(entry.label, entry.value);
  check('Fake key absent from production artifacts pages APIs logs exports and persisted records', report.leaks.length === 0, { surfaces: report.surfaces.length });
} catch (error) {
  report.errors.push({ name: error.name, message: String(error.message).replaceAll(fakeKey, '[fake-key-redacted]') });
  console.error(report.errors.at(-1).message);
  process.exitCode = 1;
} finally {
  await stop(app);
  await new Promise(resolve => provider.close(resolve));
  for (const entry of logs) scan(entry.label, entry.value);
  report.finishedAt = new Date().toISOString();
  report.summary = { passed: report.checks.filter(c => c.pass).length, failed: report.checks.filter(c => !c.pass).length, leaks: [...new Set(report.leaks)], errors: report.errors.length, localMockRequests: report.providerRequests.length, realProviderRequests: 0 };
  for (let i = 0; i < logs.length; i++) {
    const safe = logs[i].value.toString('utf8').replaceAll(fakeKey, '[fake-key-redacted]');
    await writeFile(path.join(output, `${i}-${logs[i].label}.log`), safe);
  }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`REPORT ${path.join(output, 'report.json')}`);
  console.log(JSON.stringify(report.summary));
  if (report.leaks.length || report.errors.length) process.exitCode = 1;
}

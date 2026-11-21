// HTTP integration against only the fresh, empty-config copy created by verify-optimization.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const output = path.resolve(process.argv[2] ?? "missing");
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assert.ok([path.resolve(tmpdir()), path.join(repository, "backups")].some(parent => parent.toLowerCase() === path.dirname(output).toLowerCase()));
assert.ok(path.basename(output).startsWith("afterlight-optimization-"));
const report = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
const base = report.base;
const address = new URL(base);
assert.equal(address.hostname, "127.0.0.1");
assert.notEqual(address.port, "3000");
assert.equal(report.build.code, 0);
const checks = [];
function check(name, pass) { checks.push({ name, pass: Boolean(pass) }); assert.ok(pass, name); console.log(`PASS ${name}`); }
async function request(route, body, expected = 200, method = "POST") {
  const response = await fetch(`${base}${route}`, body === undefined ? undefined : {
    method, headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, expected, `${route}: ${text.slice(0, 180)}`);
  return { response, text, json: response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : null };
}
async function idle(id) {
  for (let n = 0; n < 200; n++) {
    const { json } = await request(`/api/exhibitions/${id}/status`);
    if (!json.is_running) { assert.notEqual(json.exhibition.status, "stage_failed", JSON.stringify(json.runs)); return json; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Pipeline timed out");
}
try {
  check("isolated database starts empty", (await request("/api/exhibitions")).json.exhibitions.length === 0);
  check("real model is not configured", (await request("/api/ai/status")).json.connection.kind === "not_configured");
  const seeded = (await request("/api/demo/seed", {}, 201)).json;
  const id = seeded.id;
  check("built-in demo seeded in disposable data directory", seeded.photos > 0 && seeded.exhibition.mode === "demo");
  await request(`/api/exhibitions/${id}/runs/ingest`, { request_id: "optimization-demo-ingest" }, 202);
  const selected = await idle(id);
  check("analysis stops at selection confirmation", selected.exhibition.status === "awaiting_selection_confirm");
  await request(`/api/exhibitions/${id}/curation/confirm`, { expected_revision: selected.exhibition.input_revision, hold_policy: "include", discover_motifs: true, request_id: "optimization-demo-confirm" });
  const themed = await idle(id);
  check("themes stop at user choice", themed.exhibition.status === "awaiting_theme_choice");
  const motifs = (await request(`/api/exhibitions/${id}/motifs`)).json.motifs;
  check("demo creates theme candidates", motifs.length > 0);
  await request(`/api/exhibitions/${id}/motifs/select`, { motif_id: motifs[0].id });
  await request(`/api/exhibitions/${id}/runs/narrative`, { request_id: "optimization-demo-narrative" }, 202);
  const finished = await idle(id);
  check("narrative layout and QA finish", finished.progress.narrative && finished.progress.layout && finished.progress.qa);
  const before = (await request(`/api/exhibitions/${id}/narrative`)).json;
  const input = { expected_version: before.narrative.current_version, expected_edit_revision: before.narrative.edit_revision, edits: [{ target_path: "narrative.title", value: "隔离验证中的留影", locked: true }] };
  const edited = (await request(`/api/exhibitions/${id}/narrative`, input, 200, "PATCH")).json;
  check("edit increments revision after confirmed save", edited.narrative.title === input.edits[0].value && edited.narrative.edit_revision > before.narrative.edit_revision);
  const rejected = (await request(`/api/exhibitions/${id}/narrative`, { ...input, edits: [{ target_path: "narrative.title", value: "过期内容" }] }, 409, "PATCH")).json;
  check("stale edit is rejected", rejected.error.code === "version_conflict");
  check("stale edit leaves narrative and overrides unchanged", JSON.stringify((await request(`/api/exhibitions/${id}/narrative`)).json) === JSON.stringify(edited));
  for (const route of ["material", "selection", "motifs", "narrative", "layout"]) check(`${route} production page responds`, (await request(`/e/${id}/${route}`)).text.includes("留影"));
  const html = await request(`/api/exhibitions/${id}/export`, { format: "html" });
  check("offline HTML embeds photos and current title", html.text.includes("data:image/jpeg;base64,") && html.text.includes(input.edits[0].value) && !html.text.includes("/api/files"));
  const pack = await request(`/api/exhibitions/${id}/export`, { format: "json" });
  check("JSON export contains current title", pack.text.includes(input.edits[0].value));
  const ai = (await request("/api/exhibitions", { title: "空配置的隔离AI状态", mode: "ai", allow_external_ai: false }, 201)).json;
  const usage = (await request(`/api/exhibitions/${ai.id}/status`)).json.ai_usage;
  check("AI usage with no config returns truthful zero activity", usage.run.attempts === 0 && usage.activity.queued === 0 && usage.activity.in_flight === 0 && usage.cost === "unpriced");
  const db = new DatabaseSync(path.join(output, "data", "afterlight.db"), { readOnly: true });
  try { check("no model requests recorded", db.prepare("SELECT COUNT(*) AS n FROM ai_calls").get().n === 0); } finally { db.close(); }
} finally {
  await writeFile(path.join(output, "flow-report.json"), JSON.stringify({ checks, base, realModelCalls: 0 }, null, 2));
}

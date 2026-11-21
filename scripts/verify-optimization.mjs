// Build and smoke-test a disposable copy; never load author env/data or replace .next.
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Under ignored backups/, module resolution can use existing ancestor node_modules.
await mkdir(path.join(root, "backups"), { recursive: true });
const output = await mkdtemp(path.join(root, "backups", "afterlight-optimization-"));
const app = path.join(output, "app");
await mkdir(app);
for (const name of ["src", "public", "package.json", "package-lock.json", "tsconfig.json", "next.config.ts", "postcss.config.mjs"]) {
  await cp(path.join(root, name), path.join(app, name), { recursive: true });
}
console.log(`ISOLATED_COPY ${output}`);
// Export reads Tailwind CSS runtime assets under cwd/node_modules, as a normal install does.
await cp(path.join(root, "node_modules", "tailwindcss"), path.join(app, "node_modules", "tailwindcss"), { recursive: true });
const env = { ...process.env, AFTERLIGHT_DATA_DIR: path.join(output, "data"),
  AFTERLIGHT_MODE: "demo", AFTERLIGHT_ACCESS_MODE: "local", AFTERLIGHT_DEMO_DELAY: "0",
  AI_API_KEY: "", AI_BASE_URL: "", AI_VISION_MODEL: "", AI_TEXT_MODEL: "",
  NEXT_TELEMETRY_DISABLED: "1" };
for (const key of Object.keys(env)) if (key.startsWith("AI_") || key.startsWith("RATE_LIMIT_")) delete env[key];
Object.assign(env, { AI_API_KEY: "", AI_BASE_URL: "", AI_VISION_MODEL: "", AI_TEXT_MODEL: "" });
const cli = path.join(root, "node_modules", "next", "dist", "bin", "next");
const report = { output, build: null, checks: [], realModelCalls: 0 };
const record = async () => writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
function run(args, label) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: app, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const chunks = [];
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => chunks.push(chunk));
  const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", async (code, signal) => {
    await writeFile(path.join(output, `${label}.log`), Buffer.concat(chunks)); resolve({ code, signal });
  }); });
  return { child, done };
}
const build = run(["build", "--webpack"], "build");
const buildTimer = setTimeout(() => build.child.kill(), 300000);
try { report.build = await build.done; } finally { clearTimeout(buildTimer); await record(); }
if (report.build.code !== 0) {
  console.log(await readFile(path.join(output, "build.log"), "utf8"));
  throw new Error(`Isolated production build failed; evidence: ${output}`);
}
console.log(`BUILD_OK ${output}`);
const listener = createServer();
await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
const port = listener.address().port;
await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
const server = run(["start", "--hostname", "127.0.0.1", "--port", String(port)], "server");
const base = `http://127.0.0.1:${port}`;
report.base = base;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  if (!ready) throw new Error("Isolated production server did not start");
  for (const route of ["/", "/create", "/api/health", "/api/ai/status", "/api/exhibitions"]) {
    const response = await fetch(`${base}${route}`);
    const text = await response.text();
    const pass = response.status === 200;
    report.checks.push({ route, status: response.status, pass });
    if (!pass) throw new Error(`HTTP check failed: ${route}`);
    if (route === "/api/ai/status" && JSON.parse(text).connection.kind !== "not_configured") throw new Error("Fixture must have empty model configuration");
    if (route === "/api/exhibitions" && JSON.parse(text).exhibitions.length !== 0) throw new Error("Fixture database is not empty");
  }
  console.log(`HTTP_OK ${JSON.stringify(report.checks)}`);
  if (process.argv.includes("--flow")) {
    await record();
    const result = await new Promise((resolve, reject) => {
      const flow = spawn(process.execPath, [path.join(root, "scripts", "verify-optimization-flow.mjs"), output],
        { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      flow.stdout.on("data", chunk => process.stdout.write(chunk));
      flow.stderr.on("data", chunk => process.stderr.write(chunk));
      flow.once("error", reject); flow.once("exit", resolve);
    });
    if (result !== 0) throw new Error("Isolated HTTP flow failed");
  }
  if (process.argv.includes("--serve")) {
    console.log(`ISOLATED_SERVER ${base} DATA ${env.AFTERLIGHT_DATA_DIR}`);
    const stop = () => server.child.kill();
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    await record();
    await server.done;
  }
} finally {
  if (server.child.exitCode === null) server.child.kill();
  await server.done;
  await record();
}

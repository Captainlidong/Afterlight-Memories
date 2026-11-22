// 一次性接线脚本：为 /api/exhibitions/[id]/* 全部路由注入公网访客归属守卫。
// 本机模式（未设 AFTERLIGHT_PUBLIC）守卫为空操作，行为不变。注入后人工复核 + 回归。
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const files = execSync('find "src/app/api/exhibitions/[id]" -name "*.ts"', { encoding: "utf8" })
  .split("\n").filter(Boolean).filter((f) => !f.endsWith("[id]/route.ts")); // [id]/route.ts 已手工接线

const GUARD_FN = { GET: "requireVisitorRead", POST: "requireVisitorMutation", PATCH: "requireVisitorMutation", DELETE: "requireVisitorMutation" };
let touched = 0;

for (const file of files) {
  let src = readFileSync(file, "utf8");
  if (src.includes("requireVisitorRead") || src.includes("requireVisitorMutation")) {
    console.log("SKIP（已接线）", file);
    continue;
  }
  // 逐 handler 处理：找到 export const METHOD = handler(async (PARAM, ...) => { ... const db = getDb(); })
  const handlerRe = /export const (GET|POST|PATCH|DELETE) = handler\(async \((_?req): Request/g;
  const edits = [];
  let m;
  while ((m = handlerRe.exec(src)) !== null) {
    const method = m[1];
    const param = m[2];
    const guard = GUARD_FN[method];
    // 从 handler 开始向后找第一个 const db = getDb();
    const dbIdx = src.indexOf("const db = getDb();", m.index);
    if (dbIdx === -1) { console.log("WARN 无db行", file, method); continue; }
    const insertAt = src.indexOf("\n", dbIdx) + 1;
    const indentMatch = /^(\s*)/.exec(src.slice(insertAt));
    const indent = indentMatch ? indentMatch[1] : "  ";
    edits.push({ at: insertAt, text: `${indent}${guard}(db, ${param}, id);\n` });
  }
  // 从后往前插入，避免位移
  for (const e of edits.reverse()) src = src.slice(0, e.at) + e.text + src.slice(e.at);
  // 注入 import（插到首个 export const 行之前）
  const methods = [...src.matchAll(/export const (GET|POST|PATCH|DELETE) = handler/g)].map((x) => x[1]);
  const needs = new Set(methods.map((x) => GUARD_FN[x]));
  const importLine = `import { ${[...needs].sort().join(", ")} } from "@/lib/visitor/access";\n`;
  const firstExport = src.indexOf("export const");
  src = src.slice(0, firstExport) + importLine + src.slice(firstExport);
  writeFileSync(file, src);
  touched += 1;
  console.log("OK", file, methods.join("+"));
}
console.log(`完成：${touched} 个文件已接线`);

/**
 * 一次性 codemod：客户端同源请求统一加 apiUrl 前缀（Qoder Sites 边缘代理形态适配）。
 * 覆盖四类模式：fetch(反引号路径) / fetch("字符串路径") / xhr.open(METHOD, 路径) / img src={反引号路径}。
 * SWR 请求已在 src/lib/hooks.ts jsonFetcher 统一处理，不在此列。UploadZone 手工重写，不在此列。
 * 用法：node scripts/add-app-base.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";

const files = [
  "src/app/page.tsx",
  "src/components/AiExhibitionSettings.tsx",
  "src/components/AgentTrace.tsx",
  "src/components/StaleBanner.tsx",
  "src/components/PrivacyDelete.tsx",
  "src/components/ExportButtons.tsx",
  "src/components/DemoResetButton.tsx",
  "src/components/DemoSeedButton.tsx",
  "src/components/AiUsagePanel.tsx",
  "src/components/exhibition/ExhibitionImage.tsx",
  "src/features/create/CreateForm.tsx",
  "src/features/layout/LayoutBoard.tsx",
  "src/features/material/MaterialBoard.tsx",
  "src/features/motifs/MotifsBoard.tsx",
  "src/features/narrative/ChapterTree.tsx",
  "src/features/narrative/NarrativeBoard.tsx",
  "src/features/selection/SelectionBoard.tsx",
];

const patterns = [
  // fetch(`...`)：闭合 apiUrl 括号，fetch 原闭括号不动
  [/fetch\((`\/(?:api|demo\/)[^`]*`)/g, "fetch(apiUrl($1)"],
  // fetch("...") 纯字符串
  [/fetch\(("\/(?:api|demo\/)[^"]*")/g, "fetch(apiUrl($1)"],
  // xhr.open("METHOD", `...`)
  [/\.open\("(GET|POST|PATCH|PUT|DELETE)", (`\/(?:api|demo\/)[^`]*`)\)/g, '.open("$1", apiUrl($2))'],
  // src={`...`}
  [/src=\{(`\/api[^`]*`)\}/g, "src={apiUrl($1)}"],
];

const IMPORT = 'import { apiUrl } from "@/lib/appBase";';

let totalSites = 0;
for (const file of files) {
  const original = readFileSync(file, "utf8");
  let content = original;
  let sites = 0;
  for (const [re, replacement] of patterns) {
    content = content.replace(re, (...args) => {
      sites += 1;
      return replacement.replace(/\$(\d)/g, (_, i) => args[Number(i)]);
    });
  }
  if (sites === 0) continue;
  // 插入 import：置于首个 import 之前（"use client" 指令保持最前）
  const lines = content.split("\n");
  const firstImport = lines.findIndex((l) => /^import /u.test(l));
  if (firstImport === -1) throw new Error(`${file}: 未找到 import 行`);
  lines.splice(firstImport, 0, IMPORT);
  writeFileSync(file, lines.join("\n"));
  totalSites += sites;
  console.log(`${file}: ${sites} 处`);
}
console.log(`完成，共 ${totalSites} 处`);

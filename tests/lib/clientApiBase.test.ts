import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 架构守卫：边缘代理形态下，客户端一切同源请求必须经 apiUrl() 拼接基址
 * （src/lib/appBase.ts，构建时 NEXT_PUBLIC_APP_BASE 注入 /functions/v1/app）。
 * 本测试静态扫描 src/，捕获任何绕过 apiUrl 的裸同源绝对路径网络构造——
 * 即 2026-11-22 扫查发现的 7 组封装函数通道遗漏（选主线/QA/叙事/删照片等写操作
 * 在真实平台会 404）的防回归。
 *
 * 已知局限（由 scripts/dev-gateway.mjs 严格模式兜底）：
 * 仅捕获字面量构造；参数化封装若内部漏包 apiUrl（如 fetch(url) 形式）需靠
 * 严格网关 E2E（非 /functions/v1/app 前缀一律 404）暴露。
 */

const SRC_ROOT = join(process.cwd(), "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(p);
  }
  return out;
}

const PATTERNS: Array<[RegExp, string]> = [
  [/fetch\(\s*`\/(?:api|demo|exhibition|e\/)/, "fetch(反引号裸路径)"],
  [/fetch\(\s*"\/(?:api|demo|exhibition|e\/)/, "fetch(字符串裸路径)"],
  [/\.open\(\s*["'][A-Z]+["']\s*,\s*[`"']\/(?:api|demo|exhibition|e\/)/, "XHR.open 裸路径"],
  [/src=\{\s*`\/(?:api|demo|exhibition|e\/)/, "img/iframe src 裸路径"],
  [/src=\{\s*"\/(?:api|demo|exhibition|e\/)/, "img/iframe src 裸路径"],
  [/img\.src\s*=\s*`\/(?:api|demo|exhibition|e\/)/, "预加载 img.src 裸路径"],
];

describe("架构守卫：客户端同源请求必须经 apiUrl 拼接基址", () => {
  it("src/ 下不存在绕过 apiUrl 的裸同源绝对路径请求构造", () => {
    const violations: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const content = readFileSync(file, "utf8");
      const lines = content.split("\n");
      for (const [pattern, label] of PATTERNS) {
        lines.forEach((line, i) => {
          if (pattern.test(line)) {
            violations.push(`${file}:${i + 1} ${label} —— ${line.trim().slice(0, 100)}`);
          }
        });
      }
    }
    expect(violations).toEqual([]);
  });
});

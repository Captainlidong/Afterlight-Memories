/**
 * 边缘代理路径归一化（纯函数，无 Deno API——与 functions 入口共用，vitest 直接测试本文件）。
 *
 * Qoder Sites 网关送到函数的路径形态不定（见 Sites 插件 function-backend.md：
 * "The Function strips only the logical/local `app` or platform-generated physical
 * Function prefix … with or without the Provider-stripped /functions/v1 prefix"），
 * 生产实测（2026-11-22，308 目标） canonical 形态为：
 *   /functions/v1/app/<物理函数名 app-<hash>>/<业务路径>
 * 另有逻辑名形态 /app/<业务路径>、裸业务路径 /<业务路径> 等。
 * 源站以 basePath=/functions/v1/app 构建，转发前统一补全完整前缀，保证确定性。
 *
 * 剥离规则（逐段、最多 3 轮）：/functions/v1 段、逻辑名 app 段、物理函数名 app-<hash> 段。
 * 消歧依据：本应用业务路由只有 /api/*、/e/*、/exhibition/*、/create、/about、
 * /demo/*、/_next/*，没有任何以 /app 或 /app- 开头的业务路径，剥离无歧义。
 */
const PREFIX = "/functions/v1/app";

/** 平台生成的物理函数名段（生产实测：app-d01a203d2eff…，32 位十六进制） */
const PHYSICAL_SEGMENT = /^\/app-[0-9a-f]{6,}(?=\/|$)/i;

export function normalizeFunctionPath(pathname: string): string {
  let rest = pathname === "" ? "/" : pathname;

  // 完整前缀形态（含网关 308 后的 canonical 形态）：还需剥掉可能的物理函数名段
  if (rest === PREFIX || rest.startsWith(`${PREFIX}/`)) {
    const tail = rest.slice(PREFIX.length).replace(PHYSICAL_SEGMENT, "");
    if (tail === "" || tail === "/") return PREFIX;
    return `${PREFIX}${tail}`;
  }

  // 其余形态：逐段剥离已知的平台前缀段，再统一补全
  for (let i = 0; i < 3; i++) {
    if (rest.startsWith("/functions/v1/")) {
      rest = rest.slice("/functions/v1".length);
      continue;
    }
    if (PHYSICAL_SEGMENT.test(rest)) {
      rest = rest.replace(PHYSICAL_SEGMENT, "") || "/";
      continue;
    }
    if (rest === "/app" || rest.startsWith("/app/")) {
      rest = rest.slice("/app".length) || "/";
      continue;
    }
    break;
  }

  if (rest === "/" || rest === "") return PREFIX;
  return `${PREFIX}${rest}`;
}

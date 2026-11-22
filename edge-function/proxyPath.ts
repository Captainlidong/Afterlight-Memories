/**
 * 边缘代理路径归一化（纯函数，无 Deno API——与 functions 入口共用，vitest 直接测试本文件）。
 *
 * Qoder Sites 网关转发到函数的路径形态不定（见 Sites 插件 function-backend.md）：
 * 可能是完整 `/functions/v1/app/...`、剥掉 `/functions/v1` 的 `/app/...`、
 * 或把逻辑名一起剥掉的 `/...`。源站以 basePath=/functions/v1/app 构建，
 * 因此转发前统一补全完整前缀，保证确定性。
 *
 * 消歧依据：本应用业务路由只有 /api/*、/e/*、/exhibition/*、/create、/about、
 * /demo/*、/_next/*，不存在以 /app 或 /functions 开头的业务路径，逐段剥离无歧义。
 */
export function normalizeFunctionPath(pathname: string): string {
  const PREFIX = "/functions/v1/app";
  const rest = pathname === "" ? "/" : pathname;
  if (rest === PREFIX || rest.startsWith(`${PREFIX}/`)) return rest;
  let trimmed = rest;
  if (trimmed.startsWith("/functions/v1/")) trimmed = trimmed.slice("/functions/v1".length);
  if (trimmed === "/app" || trimmed.startsWith("/app/")) trimmed = trimmed.slice("/app".length) || "/";
  if (trimmed === "/" || trimmed === "") return PREFIX;
  return `${PREFIX}${trimmed}`;
}

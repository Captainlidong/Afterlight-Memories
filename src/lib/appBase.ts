/**
 * 客户端应用基址：Qoder Sites 边缘代理形态下，创作应用整体位于平台函数前缀
 * （构建时经 NEXT_PUBLIC_APP_BASE 注入，如 /functions/v1/app）；本机与直连部署不注入，为空串。
 * 所有客户端发起的同源请求（fetch / XHR / img src / SWR fetcher）必须经 apiUrl() 拼接，
 * 禁止硬编码绝对路径——否则代理形态下会落到平台保留命名空间之外而 404。
 */
export const APP_BASE: string = process.env.NEXT_PUBLIC_APP_BASE ?? "";

export function apiUrl(path: string): string {
  return `${APP_BASE}${path}`;
}

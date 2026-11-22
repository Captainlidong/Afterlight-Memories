import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["sharp"],
  devIndicators: false,
  // 隔离构建（如 basePath 代理形态验证）：NEXT_DIST_DIR=.next-v4 npm run build → 产物写入 .next-v4，
  // 不触碰运行中服务正在使用的 .next。next start 需以同名环境变量指向对应产物。
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Qoder Sites 边缘代理形态：创作应用整体位于平台函数前缀下（构建时注入，如 /functions/v1/app）。
  // 本机开发与直连部署不设置该变量，行为不变；客户端基址同步经 NEXT_PUBLIC_APP_BASE 注入 src/lib/appBase.ts。
  ...(process.env.AFTERLIGHT_BASE_PATH ? { basePath: process.env.AFTERLIGHT_BASE_PATH } : {}),
  // 部署展示站时用 standalone 精简产物：NEXT_OUTPUT=standalone npm run build
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" as const } : {}),
  // Proxy 层默认把请求正文截断在 10MB，多张真实照片（单张可达 14.5MB+）的批量上传会被截断导致 500。
  experimental: {
    proxyClientMaxBodySize: "80mb",
  },
};

export default nextConfig;
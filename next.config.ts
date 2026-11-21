import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["sharp"],
  devIndicators: false,
  // Proxy 层默认把请求正文截断在 10MB，多张真实照片（单张可达 14.5MB+）的批量上传会被截断导致 500。
  experimental: {
    proxyClientMaxBodySize: "80mb",
  },
};

export default nextConfig;
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    // 测试默认关闭演示延时，保持套件快速；延时专项测试自行开启。
    env: { AFTERLIGHT_DEMO_DELAY: "0" },
  },
});
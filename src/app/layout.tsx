import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "留影 Afterlight — 个人摄影叙事策展智能体",
  description:
    "上传一组照片，留影 Afterlight 用多智能体协作发现视觉主题，策划一场只属于你的个人影展。AI 帮你发现，你到底在反复拍什么。",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" data-scroll-behavior="smooth">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
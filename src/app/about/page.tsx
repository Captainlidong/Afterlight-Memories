import Link from "next/link";

export const metadata = { title: "产品说明 — 留影 Afterlight" };

export default function AboutPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="font-display text-3xl text-text">产品说明</h1>

      <section className="mt-8 space-y-4 text-sm leading-relaxed text-muted">
        <p>
          留影 Afterlight 是一个<span className="text-text">人机共同策展工具</span>。
          上传一组照片后，六个职责清晰的智能体依次协作：素材管家读取信息、审美筛选官解释哪些值得留下、
          主题发现官发现隐藏的视觉母题、叙事编剧组织开场转折与余韵、布局设计师把叙事变成网页影展、
          策展质检官检查重复编造隐私与布局问题。
        </p>
        <p>
          AI 根据照片中可观察的视觉关系提出一种观看方式，
          <span className="text-text">你保留对主题、照片、顺序和文字的最终决定权</span>。
          每个重要决定都可解释，叙事只基于可观察信息、EXIF 与你主动提供的背景。
        </p>
      </section>

      <section className="mt-10 border-t border-ink-line pt-8">
        <h2 className="mb-3 text-xs uppercase tracking-[0.2em] text-gold">
          数据来源与隐私
        </h2>
        <ul className="space-y-2 text-sm leading-relaxed text-muted">
          <li>· 原图默认保存在本地，不上传到公开服务。</li>
          <li>· 不默认保留 GPS 与相机信息；公开前会提示检查人脸、车牌与地址。</li>
          <li>· 演示模式使用 AI 生成的示例照片与本地分析结果，页面会明确标注，不伪装为实时推理。</li>
          <li>· 提供删除当前影展与所有图片的入口。</li>
        </ul>
      </section>

      <section className="mt-10 border-t border-ink-line pt-8">
        <h2 className="mb-3 text-xs uppercase tracking-[0.2em] text-gold">
          导出与删除
        </h2>
        <ul className="space-y-2 text-sm leading-relaxed text-muted">
          <li>· 导出自包含 HTML：图片降采样后内嵌，单文件可独立打开分享，绝不嵌入原图。</li>
          <li>· 导出 JSON 包：完整元数据、分析结果、你的编辑与最新版本快照。</li>
          <li>· 浏览页支持打印 / 存为 PDF（白底、章节分页）。</li>
          <li>· 删除当前影展会一并移除本机原图与缩略图文件，不可恢复；首页可一键重置演示数据。</li>
        </ul>
      </section>

      <section className="mt-10 border-t border-ink-line pt-8">
        <h2 className="mb-3 text-xs uppercase tracking-[0.2em] text-gold">
          技术实现
        </h2>
        <p className="text-sm leading-relaxed text-muted">
          Next.js 全栈（App Router + React + TypeScript + Tailwind），无独立后端进程。
          图像分析用 sharp 在原始像素上计算清晰度、亮度直方图、感知哈希与主色；数据存于本机内置 SQLite。
          布局设计师与策展质检官是确定性规则引擎，叙事经可信度校验器约束。
          你的编辑与锁定在每次重跑后回放，不会被系统悄悄覆盖；每个阶段失败都可单独重试，之前结果保留。
        </p>
      </section>

      <section className="mt-10 border-t border-ink-line pt-8">
        <h2 className="mb-3 text-xs uppercase tracking-[0.2em] text-gold">
          比赛 MVP 边界
        </h2>
        <p className="text-sm leading-relaxed text-muted">
          第一版只做一组照片、两个模板、三个章节。不做账号体系、社交、视频剪辑、自动修图、
          云端永久存储，也不对人物身份与私人关系做推断。优先保证可运行、可复现、可演示。
        </p>
      </section>

      <Link href="/" className="btn btn-ghost mt-12">
        返回首页
      </Link>
    </main>
  );
}
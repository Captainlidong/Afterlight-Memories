import Link from "next/link";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db/client";
import { listExhibitions, listExhibitionsForVisitor } from "@/lib/db/repos";
import { VISITOR_COOKIE } from "@/lib/visitor/cookie";
import { listPhotos } from "@/lib/db/photos";
import { DemoSeedButton } from "@/components/DemoSeedButton";
import { DemoResetButton } from "@/components/DemoResetButton";
import { Badge } from "@/components/ui";
import type { ExhibitionStatusT } from "@/lib/agents/schemas";
import type { Exhibition } from "@/types";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<ExhibitionStatusT, string> = {
  draft: "待上传",
  uploading: "上传中",
  ingesting: "读取素材",
  selecting: "审美筛选",
  awaiting_selection_confirm: "待确认选片",
  motifs_ready: "主题就绪",
  awaiting_theme_choice: "待选主题",
  writing: "组织叙事",
  designing: "设计布局",
  checking: "策展质检",
  awaiting_user_review: "待你确认",
  published: "已完成",
  stage_failed: "有阶段失败",
};

const SEG_FOR_STATUS: Partial<Record<ExhibitionStatusT, string>> = {
  draft: "material",
  uploading: "material",
  ingesting: "material",
  selecting: "selection",
  awaiting_selection_confirm: "selection",
  motifs_ready: "motifs",
  awaiting_theme_choice: "motifs",
  writing: "narrative",
  designing: "layout",
  checking: "layout",
  awaiting_user_review: "layout",
};

const SEG_FOR_STAGE: Record<string, string> = {
  ingest: "material",
  select: "selection",
  motifs: "motifs",
  narrative: "narrative",
  layout: "layout",
  qa: "layout",
};

const SAMPLE_PHOTOS = ["p03.jpg", "p06.jpg", "p09.jpg", "p12.jpg", "p15.jpg", "p18.jpg"];

function resumeHref(e: Exhibition): string {
  if (e.status === "published") return `/exhibition/${e.id}`;
  if (e.status === "stage_failed") {
    return `/e/${e.id}/${SEG_FOR_STAGE[e.failed_stage ?? ""] ?? "material"}`;
  }
  return `/e/${e.id}/${SEG_FOR_STATUS[e.status] ?? "material"}`;
}

function statusTone(status: ExhibitionStatusT): "muted" | "gold" | "ok" | "error" {
  if (status === "stage_failed") return "error";
  if (status === "published") return "ok";
  if (status === "awaiting_selection_confirm" || status === "awaiting_theme_choice" || status === "awaiting_user_review") {
    return "gold";
  }
  return "muted";
}

function fmtUpdated(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

export default async function HomePage() {
  const db = getDb();
  // 展示站点模式（AFTERLIGHT_SHOWCASE=1）：只浏览，不提供创建/演示数据入口。
  const isShowcaseSite = process.env.AFTERLIGHT_SHOWCASE === "1";
  // 公网完整版（AFTERLIGHT_PUBLIC=1）：匿名会话隔离，访客可完整创作（AI 受额度与时时段约束）。
  const isPublicVisitor = process.env.AFTERLIGHT_PUBLIC === "1";
  const cookieStore = isPublicVisitor ? await cookies() : null;
  const visitorSid = isPublicVisitor ? cookieStore?.get(VISITOR_COOKIE)?.value ?? null : null;
  const exhibitions = isPublicVisitor
    ? (visitorSid ? listExhibitionsForVisitor(db, visitorSid) : [])
    : listExhibitions(db);
  const showcase = exhibitions.find((e) => e.is_demo_set) ?? null;
  const showcaseHref = showcase ? `/exhibition/${showcase.id}` : "/create";

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-20">
      <p className="mb-6 text-xs uppercase tracking-[0.3em] text-gold">
        留影 Afterlight
      </p>

      <h1 className="font-display text-4xl leading-snug text-text md:text-5xl">
        你拍下的这些照片，
        <br />
        放在一起会讲什么？
      </h1>

      <p className="mt-6 max-w-xl text-base leading-relaxed text-muted">
        留影 Afterlight 用 AI 帮你从一组照片中发现视觉主题，策划一场只属于你的个人影展。
        它不替你决定人生故事，而是帮你发现：你到底在反复拍什么，以及这些照片可以怎样被观看。
      </p>

      {isPublicVisitor && (
        <p className="mt-4 text-xs leading-relaxed text-muted">
          在线体验为临时数据（保留 1 小时），喜欢请及时导出保存；每个访客可体验 1 次真实 AI 策展（DeepSeek 空闲时段开放，每日名额有限）。
        </p>
      )}

      {!isShowcaseSite && (
        <div className="mt-10 flex flex-wrap gap-4">
          <Link href="/create" className="btn btn-primary">
            开始策展
          </Link>
          <DemoSeedButton />
        </div>
      )}

      {showcase && (
      <Link
        href={showcaseHref}
        className="group relative mt-10 block overflow-hidden rounded-lg border border-ink-line transition-colors hover:border-gold/50"
        aria-label="查看示例影展"
      >
        <div className="flex gap-1.5 p-1.5">
          {SAMPLE_PHOTOS.map((name, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={name}
              src={`/demo/photos/${name}`}
              alt={`示例照片 ${i + 1}`}
              loading={i === 0 ? "eager" : "lazy"}
              className={`h-32 min-w-0 flex-1 rounded-sm object-cover sm:h-40 ${i > 3 ? "hidden sm:block" : ""}`}
            />
          ))}
        </div>
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-ink via-ink/10 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 p-4">
          <div>
            <p className="text-[10px] uppercase tracking-[0.25em] text-gold">示例影展</p>
            <p className="mt-1 font-display text-lg text-text">{showcase.title || "在光线转弯之前"}</p>
            <p className="mt-0.5 text-xs text-muted">进入 / 经过 / 留下 · 24 张照片</p>
          </div>
          <span className="btn btn-outline !min-h-9 shrink-0 !px-3 text-xs group-hover:border-gold/60">
            观看完整影展 →
          </span>
        </div>
      </Link>
      )}

      <div className="mt-10 flex items-center gap-3 text-sm text-muted">
        <span className="text-text">24 张照片</span>
        <span className="text-gold">→</span>
        <span className="text-text">3 个视觉母题</span>
        <span className="text-gold">→</span>
        <span className="text-text">1 场个人影展</span>
      </div>

      {exhibitions.length > 0 && (
        <section className="mt-14 border-t border-ink-line pt-8">
          {/* 列表默认折叠：首页保持「打开就能用」的简洁，自己的影展按需展开查看。 */}
          <details>
            <summary className="flex cursor-pointer list-none items-end justify-between gap-4">
              <span>
                <span className="text-xs uppercase tracking-[0.2em] text-muted">
                  {isShowcaseSite ? "在线影展" : isPublicVisitor ? "我的影展" : "继续编辑"}
                </span>
                <span className="mt-1 block text-xs text-muted">
                  {isShowcaseSite ? "点击展开，浏览本站收录的影展。" : isPublicVisitor ? "只显示你自己创建的影展（1 小时后自动清理）。" : "从最近的进度接着做，或打开已完成的影展观看。"}
                </span>
              </span>
              <span className="text-xs text-muted">{exhibitions.length} 场 ▾</span>
            </summary>
          <ul className="mt-4 space-y-2">
            {exhibitions.map((e) => {
              const photos = listPhotos(db, e.id);
              const confirmedCover = e.selection_confirmed_photo_ids?.find((pid) => photos.some((p) => p.id === pid));
              const coverId = confirmedCover ?? photos[0]?.id ?? null;
              const watchable = e.status === "awaiting_user_review" || e.status === "published";
              const status = e.status as ExhibitionStatusT;
              return (
                <li
                  key={e.id}
                  className="flex items-center gap-3 rounded-md border border-ink-line p-3 transition-colors hover:border-gold/50"
                >
                  <Link href={resumeHref(e)} className="flex min-w-0 flex-1 items-center gap-3">
                    {coverId ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`/api/files/${e.id}/${coverId}?variant=thumb`}
                        alt=""
                        className="h-14 w-14 shrink-0 rounded-sm border border-ink-line object-cover"
                      />
                    ) : (
                      <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-sm border border-ink-line bg-ink-soft text-[10px] text-muted">
                        留影
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm text-text">{e.title || "未命名影展"}</span>
                        <Badge tone={statusTone(status)}>{STATUS_LABEL[status] ?? status}</Badge>
                      </span>
                      <span className="mt-1 block text-xs text-muted">
                        更新于 {fmtUpdated(e.updated_at)} · 从本步继续
                      </span>
                    </span>
                  </Link>
                  {watchable && (
                    <Link
                      href={`/exhibition/${e.id}`}
                      className="shrink-0 rounded-md px-2 py-1 text-xs text-gold transition-colors hover:bg-gold/10"
                    >
                      观看 →
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
          </details>
        </section>
      )}

      <footer className="mt-20 flex flex-wrap items-center justify-between gap-4 text-xs text-muted">
        <span>
          <Link href="/about" className="hover:text-gold">
            产品说明
          </Link>
          <span className="mx-2">·</span>
          <span>{isShowcaseSite ? "展示站点 · 影展内容经作者允许公开浏览" : "本地优先 · 不默认上传原图"}</span>
        </span>
        {!isShowcaseSite && <DemoResetButton />}
      </footer>
    </main>
  );
}

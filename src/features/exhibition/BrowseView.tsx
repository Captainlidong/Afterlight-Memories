"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePreview, useStatus } from "@/lib/hooks";
import { LayoutRenderer } from "@/components/exhibition/LayoutRenderer";
import { DemoBadge } from "@/components/DemoBadge";
import { getSourceLabel } from "@/components/AgentTrace";
import { ExportButtons } from "@/components/ExportButtons";
import { Spinner, EmptyState } from "@/components/ui";
import { LoadError } from "@/components/LoadError";
import { buildPlaybackRoute } from "@/lib/exhibition/playbackPlan";
import { useExhibitionPlayback } from "./useExhibitionPlayback";
import { PlaybackControls } from "./PlaybackControls";

/**
 * 影展浏览视图（§8 / §19.7–19.9）：读 preview bundle → LayoutRenderer + 放映引擎。
 * 一套观影控制：桌面顶部标题+章节+更多菜单，底部紧凑播放条；手机章节可折叠。
 * ?play=1 携带一次性播放意图（一键放映），消费后从 URL 移除，刷新不重播；
 * 直达链接默认静止，点「开始放映」才动。embed=1 只预览不隐式播放，可显式试播（只滚 iframe）。
 */
export function BrowseView({
  exhibitionId,
  embed = false,
  playIntent = false,
}: {
  exhibitionId: string;
  embed?: boolean;
  playIntent?: boolean;
}) {
  const status = useStatus(exhibitionId);
  const running = status.data?.is_running ?? false;
  const { data, isLoading, error, mutate } = usePreview(exhibitionId, running);
  const [active, setActive] = useState<string | null>(null);

  const narrative = data?.narrative ?? null;
  const layout = data?.layout ?? null;
  const chapters = useMemo(() => narrative?.chapters ?? [], [narrative]);

  // 生成结束瞬间 preview 可能停在完成前的一帧：工作流或完成态变化后主动重取一次。
  const lastProgressRef = useRef("");
  useEffect(() => {
    const d = status.data;
    if (!d) return;
    const key = `${d.workflow_id ?? ""}:${d.progress.narrative}:${d.progress.layout}:${d.progress.qa}`;
    if (lastProgressRef.current === key) return;
    lastProgressRef.current = key;
    void mutate();
  }, [status.data, mutate]);

  const route = useMemo(() => {
    if (!layout || !narrative || !data) return null;
    return buildPlaybackRoute({
      sections: layout.sections,
      chapters: narrative.chapters,
      photos: Object.fromEntries(
        data.photos.map((p) => [
          p.id,
          p.width != null && p.height != null ? { width: p.width, height: p.height } : undefined,
        ]),
      ),
      curatorialStatement: narrative.curatorial_statement,
    });
  }, [layout, narrative, data]);

  const api = useExhibitionPlayback({
    exhibitionId,
    route,
    layoutVersion: layout?.updated_at ?? null,
    ready: !!narrative && !!layout,
    autoStart: playIntent && !embed,
    embed,
  });

  useEffect(() => {
    if (!layout) return;
    const intros = chapters
      .map((c) => document.getElementById(`intro_${c.id}`))
      .filter((el): el is HTMLElement => !!el);
    if (!intros.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActive(e.target.id);
        }
      },
      { rootMargin: "-40% 0px -55% 0px" },
    );
    intros.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [layout, chapters]);

  useEffect(() => {
    if (!layout) return;
    const hash = decodeURIComponent(window.location.hash.slice(1));
    if (!hash) return;
    // section 由客户端渲染，原生 hash 滚动早于挂载 → 渲染后补一次定位
    document.getElementById(hash)?.scrollIntoView({ behavior: "instant" });
  }, [layout]);

  useEffect(() => {
    if (!layout) return;
    // Reveal 为无 hook 纯标记（服务端导出复用）；揭示动画统一在此激活
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(".reveal:not(.is-visible)"));
    if (!nodes.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("is-visible");
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.12 },
    );
    nodes.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [layout]);

  if (isLoading) {
    return <div className="flex min-h-screen items-center justify-center"><Spinner label="正在载入影展…" /></div>;
  }

  // 请求失败 ≠ 业务空态（§19.6 / UX28）：网络/服务错误给重试，不误报「尚未生成」。
  if (error && !data) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-24">
        <LoadError message="无法加载影展内容，请检查网络后重试。" onRetry={() => mutate()} />
      </div>
    );
  }

  if (!narrative || !layout) {
    const readyButSyncing = !!(status.data?.progress.narrative && status.data?.progress.layout);
    if (running || readyButSyncing) {
      return (
        <div className="mx-auto flex min-h-[70vh] max-w-md flex-col items-center justify-center gap-4 px-6 text-center" aria-live="polite">
          <span className="text-xs uppercase tracking-[0.25em] text-gold">{running ? "生成中" : "同步中"}</span>
          <h1 className="font-display text-xl text-text">{running ? "影展正在生成" : "正在载入生成结果"}</h1>
          <Spinner label={running ? "叙事与版式完成后，本页会自动刷新" : "正在同步最新影展，通常只需一两秒"} />
          <Link href="/" className="text-xs text-muted hover:text-gold">先返回首页</Link>
        </div>
      );
    }
    return (
      <div className="mx-auto max-w-2xl px-6 py-24">
        <EmptyState
          title="影展尚未生成"
          description="请先完成叙事与布局设计，再浏览影展。"
          action={<Link href={`/e/${exhibitionId}/layout`} className="btn btn-primary">前往布局设计</Link>}
        />
      </div>
    );
  }

  const badgeVariant = narrative.source === "heuristic" ? "heuristic" : narrative.source === "demo_preset" ? "preset" : null;

  function gotoChapter(e: React.MouseEvent, chapterId: string) {
    e.preventDefault();
    // 章节导航先暂停，定位所选章节，用户可点继续
    api.gotoChapter(chapterId);
    (e.currentTarget as HTMLElement).closest("details")?.removeAttribute("open");
  }

  const chapterLinks = chapters.map((c) => (
    <a
      key={c.id}
      href={`#intro_${c.id}`}
      onClick={(e) => gotoChapter(e, c.id)}
      className={active === `intro_${c.id}` ? "active" : ""}
    >
      {c.title}
    </a>
  ));

  return (
    <div className={embed ? "pb-20" : "pt-12 pb-28"}>
      {!embed && (
        <nav className="exhibition-nav">
          <span className="max-w-[38vw] truncate font-display text-sm text-text md:max-w-none">{narrative.title}</span>
          <div className="mx-auto hidden items-center gap-4 overflow-x-auto md:flex">{chapterLinks}</div>
          <details className="relative md:hidden">
            <summary className="btn btn-ghost !min-h-9 !px-2 !py-1 text-xs">章节 ▾</summary>
            <div className="absolute left-0 top-full z-50 mt-1 flex min-w-40 flex-col gap-1 rounded-md border border-ink-line bg-ink/95 p-2 backdrop-blur">
              {chapterLinks}
            </div>
          </details>
          <div className="ml-auto flex items-center gap-1 md:ml-0">
            <details className="relative">
              <summary className="btn btn-ghost !min-h-9 !px-2 !py-1 text-xs">更多 ▾</summary>
              <div className="absolute right-0 top-full z-50 mt-1 flex min-w-44 flex-col items-stretch gap-1 rounded-md border border-ink-line bg-ink/95 p-2 backdrop-blur">
                <Link
                  href="/"
                  className="btn btn-outline !justify-start !border-gold/40 !px-3 !py-1.5 text-xs !text-gold"
                  onClick={(e) => (e.currentTarget as HTMLElement).closest("details")?.removeAttribute("open")}
                >
                  ← 返回首页
                </Link>
                <Link
                  href={`/e/${exhibitionId}/layout`}
                  className="btn btn-outline !justify-start !px-3 !py-1.5 text-xs"
                  onClick={(e) => (e.currentTarget as HTMLElement).closest("details")?.removeAttribute("open")}
                >
                  返回编辑
                </Link>
                <div className="my-1 border-t border-ink-line" />
                <ExportButtons exhibitionId={exhibitionId} className="!flex-col !items-stretch" />
                <button
                  className="btn btn-ghost !justify-start !px-3 !py-1.5 text-xs"
                  onClick={(e) => {
                    (e.currentTarget as HTMLElement).closest("details")?.removeAttribute("open");
                    window.print();
                  }}
                >
                  打印 / 存为 PDF
                </button>
              </div>
            </details>
          </div>
        </nav>
      )}

      <LayoutRenderer layout={layout} narrative={narrative} photos={data!.photos} exhibitionId={exhibitionId} />

      <PlaybackControls api={api} exhibitionId={exhibitionId} embed={embed} author={!embed} />
      {badgeVariant ? (
        <DemoBadge variant={badgeVariant} compact />
      ) : (
        <span className="fixed left-3 top-14 z-30 inline-flex min-h-8 max-w-xs items-center rounded-full border border-ink-line bg-ink/85 px-3 text-[11px] text-muted backdrop-blur">
          {getSourceLabel(narrative.source)}
        </span>
      )}
    </div>
  );
}
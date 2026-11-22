"use client";

import { apiUrl } from "@/lib/appBase";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { mutate } from "swr";
import { useStatus, usePreview } from "@/lib/hooks";
import type { TemplateT } from "@/lib/agents/schemas";
import { Button, Spinner, EmptyState } from "@/components/ui";
import { AgentTrace } from "@/components/AgentTrace";
import { LoadError } from "@/components/LoadError";
import { ExportButtons } from "@/components/ExportButtons";
import { QaPanel } from "./QaPanel";
import { requestId } from "@/lib/uuid";

const JSON_HEADERS = { "content-type": "application/json" };

const RUN_LABEL: Record<string, string> = {
  material_steward: "读取照片",
  aesthetic_selector: "推荐选片",
  motif_finder: "发现主题",
  narrative_editor: "组织影展内容",
  exhibition_designer: "安排观看节奏",
  curatorial_qa: "检查影展",
};

const TEMPLATES: { id: TemplateT; name: string; desc: string; swatch: string; text: string }[] = [
  { id: "cinema_scroll", name: "电影卷轴", desc: "深色背景 · 首屏大图 · 章节长留白 · 适合安静、纪实与低饱和照片", swatch: "#101114", text: "#f5f1e8" },
  { id: "archive_collage", name: "档案拼贴", desc: "纸张浅色 · 大小图交替 · 档案注释 · 适合旅行、校园与日常记录", swatch: "#f4f0e8", text: "#24211e" },
];

/**
 * 布局设计页（§8）：两模板卡 + 桌面/手机设备预览（iframe /exhibition/[id]?embed=1，真响应式零重复代码）
 * + 重新排版 + 策展质检面板。换模板只重跑 layout→qa（照片/叙事不变）；过期提示由全局 stale 横幅承担。
 */
export function LayoutBoard({ exhibitionId }: { exhibitionId: string }) {
  const status = useStatus(exhibitionId);
  const running = status.data?.is_running ?? false;
  const preview = usePreview(exhibitionId, running);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exh = status.data?.exhibition;
  const narrative = preview.data?.narrative ?? null;
  const layout = preview.data?.layout ?? null;
  const narrativeReady = status.data?.progress.narrative ?? false;
  const mutatePreview = preview.mutate;

  // 运行结束后 preview 可能停在完成前的最后一帧（轮询已停）：工作流或阶段完成态变化时主动重取一次。
  const lastProgressRef = useRef("");
  useEffect(() => {
    const d = status.data;
    if (!d) return;
    const key = `${d.workflow_id ?? ""}:${d.progress.narrative}:${d.progress.layout}:${d.progress.qa}`;
    if (lastProgressRef.current === key) return;
    lastProgressRef.current = key;
    void mutatePreview();
  }, [status.data, mutatePreview]);

  async function refresh() {
    await Promise.all([
      mutate(`/api/exhibitions/${exhibitionId}/preview`),
      mutate(`/api/exhibitions/${exhibitionId}/status`),
    ]);
  }

  async function run(url: string, init: RequestInit | undefined, failMsg: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, init);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message ?? failMsg);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : failMsg);
    } finally {
      setBusy(false);
    }
  }

  const relayout = () =>
    run(`/api/exhibitions/${exhibitionId}/runs/layout`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ request_id: requestId() }) }, "布局生成失败");

  async function chooseTemplate(t: TemplateT) {
    if (t === exh?.template) return;
    setBusy(true);
    setError(null);
    try {
      const patch = await fetch(apiUrl(`/api/exhibitions/${exhibitionId}`), {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ template: t }),
      });
      if (!patch.ok) throw new Error((await patch.json())?.error?.message ?? "模板切换失败");
      if (narrative) {
        const res = await fetch(apiUrl(`/api/exhibitions/${exhibitionId}/runs/layout`), { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ request_id: requestId() }) });
        if (!res.ok) throw new Error((await res.json())?.error?.message ?? "布局生成失败");
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "模板切换失败");
    } finally {
      setBusy(false);
    }
  }

  if (status.error && !status.data) {
    return <LoadError message="无法加载影展状态，请检查网络后重试。" onRetry={() => status.mutate()} />;
  }
  if (preview.error && !preview.data) {
    return <LoadError message="无法加载预览内容，请检查网络后重试。" onRetry={() => preview.mutate()} />;
  }

  if ((status.isLoading && !status.data) || (preview.isLoading && !preview.data)) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Spinner label="正在载入版式…" />
      </div>
    );
  }

  if (!narrative && (running || narrativeReady)) {
    const currentRun = [...(status.data?.runs ?? [])].reverse().find((r) => r.status === "running");
    return (
      <div className="flex flex-col gap-6">
        <header>
          <h1 className="font-display text-2xl text-text">预览版式</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
            布局设计师把章节与照片顺序转化为网页影展：首图、留白、节奏与结尾都参与表达。
          </p>
        </header>
        <section className="card border-gold/30 px-6 py-10 text-center" aria-live="polite">
          <p className="text-xs uppercase tracking-[0.25em] text-gold">{running ? "生成中" : "同步中"}</p>
          <h2 className="mt-3 font-display text-xl text-text">{running ? "排版进行中" : "正在载入生成结果"}</h2>
          <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted">
            {running
              ? "你比生成进度快了一步。叙事与版式完成后，本页会自动刷新，无需返回上一步重来。"
              : "内容已经生成，正在同步最新版式；通常只需一两秒。"}
          </p>
          <div className="mt-6 flex flex-col items-center gap-3">
            <Spinner
              label={
                currentRun
                  ? `正在${RUN_LABEL[currentRun.agent_type] ?? "生成内容"}`
                  : running
                    ? "正在生成内容与版式"
                    : "正在同步最新内容"
              }
            />
            <span className="text-xs text-muted">离开本页不会中断生成，稍后可从首页继续。</span>
          </div>
        </section>
        <AgentTrace exhibitionId={exhibitionId} runs={status.data?.runs ?? []} />
      </div>
    );
  }

  if (!narrative) {
    return (
      <EmptyState
        title="还没有内容"
        description="版式会把叙事章节转化为可浏览的影展。请先回到上一步生成内容。"
        action={<Link href={`/e/${exhibitionId}/narrative`} className="btn btn-primary">去调整内容 →</Link>}
      />
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="font-display text-2xl text-text">预览版式</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          布局设计师把章节与照片顺序转化为网页影展：首图、留白、节奏与结尾都参与表达。
          切换模板只改变色板与排版，不会改动你的照片与叙事。
        </p>
      </header>

      {error && <div className="card border-error/40 px-4 py-3 text-sm text-error">{error}</div>}

      <section className="grid gap-4 md:grid-cols-2">
        {TEMPLATES.map((t) => {
          const selected = exh?.template === t.id;
          return (
            <button
              key={t.id}
              onClick={() => chooseTemplate(t.id)}
              disabled={busy}
              className={`card flex items-start gap-4 p-4 text-left transition-colors ${selected ? "border-gold ring-1 ring-gold/40" : "hover:border-gold/40"}`}
            >
              <span className="mt-1 h-12 w-12 shrink-0 rounded-md border border-ink-line" style={{ background: t.swatch }}>
                <span className="block h-full w-full rounded-md" style={{ boxShadow: `inset 0 0 0 2px ${t.text}22` }} />
              </span>
              <span>
                <span className="flex items-center gap-2 font-display text-lg text-text">
                  {t.name}
                  {selected && <span className="text-xs text-gold">当前</span>}
                </span>
                <span className="mt-1 block text-xs leading-relaxed text-muted">{t.desc}</span>
              </span>
            </button>
          );
        })}
      </section>

      <section className="flex flex-wrap items-center gap-3">
        {layout && (
          <Link href={`/exhibition/${exhibitionId}?play=1`} className="btn btn-primary">
            一键放映 ▶
          </Link>
        )}
        <Button variant="outline" onClick={relayout} disabled={busy || running}>
          {busy || running ? <Spinner label="排版中…" /> : layout ? "重新排版" : "生成布局"}
        </Button>
        <Link href={`/exhibition/${exhibitionId}`} target="_blank" className="btn btn-outline">浏览影展</Link>
        <ExportButtons exhibitionId={exhibitionId} />
        <div className="ml-auto flex items-center gap-1 rounded-md border border-ink-line p-1">
          <button className={`rounded px-3 py-1 text-xs ${device === "desktop" ? "bg-gold/15 text-gold" : "text-muted"}`} onClick={() => setDevice("desktop")}>桌面</button>
          <button className={`rounded px-3 py-1 text-xs ${device === "mobile" ? "bg-gold/15 text-gold" : "text-muted"}`} onClick={() => setDevice("mobile")}>手机</button>
        </div>
      </section>

      <section className="card overflow-hidden p-4">
        {layout ? (
          <div className="flex justify-center bg-ink py-4">
            <div
              className={device === "mobile" ? "w-[390px] overflow-hidden rounded-[1.5rem] border-4 border-ink-line" : "w-full overflow-hidden rounded-md border border-ink-line"}
              style={{ height: 720 }}
            >
              <iframe
                key={`${device}-${layout.updated_at}`}
                src={`/exhibition/${exhibitionId}?embed=1`}
                title="影展预览"
                className="h-full w-full border-0"
              />
            </div>
          </div>
        ) : (
          <div className="py-16 text-center text-sm text-muted">
            {running ? <Spinner label="正在安排观看节奏…" /> : "尚未生成布局，点击「生成布局」开始。"}
          </div>
        )}
        <p className="mt-3 text-center text-xs text-muted">
          {device === "mobile" ? "390px 移动预览（与浏览页同一渲染器，真响应式）" : "桌面全宽预览"}
        </p>
      </section>

      <QaPanel exhibitionId={exhibitionId} layout={layout} running={running} />

      <AgentTrace exhibitionId={exhibitionId} runs={status.data?.runs ?? []} />
    </div>
  );
}
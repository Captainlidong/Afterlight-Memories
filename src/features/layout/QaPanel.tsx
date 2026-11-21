"use client";

import { useState } from "react";
import Link from "next/link";
import { mutate } from "swr";
import { useQa } from "@/lib/hooks";
import type { LayoutDTO, QaDTO } from "@/types";
import type { QaIssueT } from "@/lib/agents/schemas";
import { Button, Badge, Spinner } from "@/components/ui";

const JSON_HEADERS = { "content-type": "application/json" };

const TYPE_LABEL: Record<QaIssueT["type"], string> = {
  repetition: "跨区重复",
  similar_run: "相似连排",
  chapter_rhythm: "章节节奏",
  credibility: "文案可信度",
  must_keep_missing: "必留缺席",
  mobile_overflow: "移动端溢出",
  duplicate_title: "章节重名",
  abrupt_ending: "结尾突兀",
  broken_file: "坏文件",
  privacy_hint: "隐私提示",
};

const SEVERITY_TONE = { low: "muted", medium: "warn", high: "error" } as const;
const SEVERITY_LABEL = { low: "提示", medium: "建议", high: "需处理" } as const;

/** 定位锚点：优先引用该照片的 section，其次章节 intro。 */
function anchorOf(issue: QaIssueT, layout: LayoutDTO | null): string | null {
  if (!layout) return null;
  const pid = issue.photo_ids[0];
  if (pid) {
    const sec = layout.sections.find((s) => {
      if (s.type === "hero" || s.type === "single_image") return s.photo_id === pid;
      if (s.type === "image_pair" || s.type === "image_group" || s.type === "ending") return s.photo_ids.includes(pid);
      return false;
    });
    if (sec) return sec.id;
  }
  if (issue.chapter_id) return `intro_${issue.chapter_id}`;
  return null;
}

/**
 * 策展质检面板（§6.7 / §8）：问题定位/忽略/自动修复 + 通过项 + 已忽略清单。
 * 忽略键跨重跑保留；自动修复只动布局结构，不碰用户文案。
 */
export function QaPanel({ exhibitionId, layout, running }: { exhibitionId: string; layout: LayoutDTO | null; running: boolean }) {
  const qa = useQa(exhibitionId, running);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report: QaDTO | null = qa.data?.qa ?? null;

  async function act(key: string, url: string, body?: unknown) {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body ?? {}) });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message ?? "操作失败");
      await Promise.all([
        mutate(`/api/exhibitions/${exhibitionId}/qa`),
        mutate(`/api/exhibitions/${exhibitionId}/preview`),
        mutate(`/api/exhibitions/${exhibitionId}/status`),
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(null);
    }
  }

  const runQa = () => act("run", `/api/exhibitions/${exhibitionId}/runs/qa`);

  if (!report) {
    return (
      <section className="card flex flex-wrap items-center justify-between gap-3 px-4 py-4">
        <span className="text-sm text-muted">
          {running ? <Spinner label="正在检查影展…" /> : "还没有检查影展。检查会找出重复、节奏、可信度与必留照片的问题。"}
        </span>
        <Button variant="outline" className="!py-1.5 text-xs" disabled={running || busy !== null} onClick={runQa}>
          运行质检
        </Button>
      </section>
    );
  }

  const row = (issue: QaIssueT, ignored: boolean) => {
    const anchor = anchorOf(issue, layout);
    return (
      <li key={issue.id} className="flex flex-wrap items-start gap-3 border-t border-ink-line px-4 py-3 first:border-t-0">
        <Badge tone={SEVERITY_TONE[issue.severity]}>{SEVERITY_LABEL[issue.severity]}</Badge>
        <span className="min-w-0 flex-1 text-sm">
          <span className="mr-2 text-xs text-muted">{TYPE_LABEL[issue.type]}</span>
          <span className="text-text">{issue.message}</span>
          {issue.photo_ids.length > 0 && <span className="ml-2 text-xs text-muted">涉及 {issue.photo_ids.length} 张照片</span>}
        </span>
        <span className="flex items-center gap-2">
          {anchor && (
            <Link href={`/exhibition/${exhibitionId}#${anchor}`} target="_blank" className="btn btn-ghost !py-1 text-xs">
              定位
            </Link>
          )}
          {!ignored && issue.auto_fix_available && (
            <Button variant="outline" className="!py-1 text-xs" disabled={busy !== null || running} onClick={() => act(issue.id, `/api/exhibitions/${exhibitionId}/qa/issues/${issue.id}/fix`)}>
              {busy === issue.id ? <Spinner /> : "自动修复"}
            </Button>
          )}
          <Button variant="ghost" className="!py-1 text-xs" disabled={busy !== null || running} onClick={() => act(issue.id, `/api/exhibitions/${exhibitionId}/qa/issues/${issue.id}/ignore`, { ignored: !ignored })}>
            {ignored ? "恢复" : "忽略"}
          </Button>
        </span>
      </li>
    );
  };

  return (
    <section className="card overflow-hidden">
      <header className="flex flex-wrap items-center gap-3 px-4 py-3">
        <h2 className="font-display text-lg text-text">策展质检</h2>
        <Badge tone={report.status === "passed" ? "ok" : "warn"}>
          {report.status === "passed" ? "通过" : "需人工确认"}
        </Badge>
        <span className="text-xs text-muted">
          {report.issues.length} 个活跃问题 · {report.ignored_issues.length} 个已忽略
        </span>
        <span className="ml-auto">
          <Button variant="outline" className="!py-1.5 text-xs" disabled={running || busy !== null} onClick={runQa}>
            {running ? <Spinner label="质检中…" /> : "重新质检"}
          </Button>
        </span>
      </header>
      {error && <div className="border-t border-error/40 px-4 py-2 text-sm text-error">{error}</div>}
      {report.issues.length === 0 ? (
        <p className="border-t border-ink-line px-4 py-4 text-sm text-muted">没有活跃问题。发布前仍请人工过目一遍照片与文案。</p>
      ) : (
        <ul>{report.issues.map((i) => row(i, false))}</ul>
      )}
      {report.ignored_issues.length > 0 && (
        <details className="border-t border-ink-line px-4 py-3">
          <summary className="cursor-pointer text-xs text-muted">已忽略的问题（{report.ignored_issues.length}）——忽略会在重跑后保留</summary>
          <ul className="mt-2 rounded-md border border-ink-line">{report.ignored_issues.map((i) => row(i, true))}</ul>
        </details>
      )}
      <details className="border-t border-ink-line px-4 py-3">
        <summary className="cursor-pointer text-xs text-muted">通过的检查（{report.passed_checks.length}）</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted">
          {report.passed_checks.map((c) => <li key={c}>{c}</li>)}
        </ul>
      </details>
    </section>
  );
}
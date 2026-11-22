"use client";

import { apiUrl } from "@/lib/appBase";
import { useEffect, useState } from "react";
import useSWR, { mutate } from "swr";
import { jsonFetcher, type RunSummary } from "@/lib/hooks";
import type { AgentRun } from "@/types";
import type { RunStatusT } from "@/lib/agents/schemas";
import { Badge, Button, Spinner } from "@/components/ui";

/** 只按明确记录的来源标注，旧值不推断为 AI 或演示。 */
export function getSourceLabel(source: unknown): string {
  switch (source) {
    case "ai": return "AI 分析/生成";
    case "ai_cache": return "AI 已有分析，本次未重新发送";
    case "demo_preset": return "演示预设";
    case "heuristic": return "本地规则";
    default: return "来源未记录";
  }
}

function outputSourceLabel(output: unknown): string | null {
  if (!output || typeof output !== "object" || Array.isArray(output) || !("provenance" in output)) return null;
  const provenance = output.provenance;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return null;
  const source = "source" in provenance ? provenance.source : undefined;
  return source === "mixed" ? "混合来源" : getSourceLabel(source);
}

/** 技术名保留在详情弹窗与悬停提示里；默认行文案用普通用户语言（§19.6 术语表）。 */
const AGENT_LABEL: Record<string, string> = {
  material_steward: "素材管家",
  aesthetic_selector: "审美筛选官",
  motif_finder: "主题发现官",
  narrative_editor: "叙事编剧",
  exhibition_designer: "布局设计师",
  curatorial_qa: "策展质检官",
};

const USER_LABEL: Record<string, string> = {
  material_steward: "读取照片",
  aesthetic_selector: "推荐选片",
  motif_finder: "寻找照片之间的联系",
  narrative_editor: "组织影展内容",
  exhibition_designer: "安排观看节奏",
  curatorial_qa: "检查影展",
};

function runLabel(run: { agent_type: string; status: string }): string {
  const user = USER_LABEL[run.agent_type];
  if (!user) return AGENT_LABEL[run.agent_type] ?? run.agent_type;
  return run.status === "running" ? `正在${user}` : user;
}

const STATUS_LABEL: Record<RunStatusT, string> = {
  pending: "等待",
  running: "运行中",
  completed: "完成",
  failed: "失败",
  skipped: "跳过",
};

/** 运行中实时耗时：轮询间隙也在走字，页面不会看起来卡死（§17.4）。 */
function LiveElapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const start = Date.parse(since);
  const secs = Math.max(0, (now - start) / 1000);
  return <span className="text-xs text-gold">{secs.toFixed(1)}s</span>;
}

function StatusIcon({ status }: { status: string }) {
  if (status === "completed") return <span className="text-ok">✓</span>;
  if (status === "running")
    return <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-gold" />;
  if (status === "failed") return <span className="text-error">✕</span>;
  if (status === "skipped") return <span className="text-muted">–</span>;
  return <span className="text-muted">○</span>;
}

function RunRow({ run, onOpen }: { run: RunSummary; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={AGENT_LABEL[run.agent_type] ?? run.agent_type}
      className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-ink-soft"
    >
      <span className="w-4 text-center">
        <StatusIcon status={run.status} />
      </span>
      <span className="flex-1 text-text">{runLabel(run)}</span>
      {run.status === "running" ? (
        <LiveElapsed since={run.created_at} />
      ) : (
        run.duration_ms != null && (
          <span className="text-xs text-muted">{(run.duration_ms / 1000).toFixed(1)}s</span>
        )
      )}
      <Badge tone={run.status === "failed" ? "error" : run.status === "completed" ? "ok" : "muted"}>
        {STATUS_LABEL[run.status] ?? run.status}
      </Badge>
    </button>
  );
}

/**
 * 智能体轨迹（§19.1 F 降噪 / §19.6）：默认只展示最近一次工作流，行文案用普通用户语言；
 * 历史运行折叠在「历史处理记录」里；技术名与输入输出 JSON 留在详情弹窗；重试统一走 /runs/retry。
 */
export function AgentTrace({ exhibitionId, runs }: { exhibitionId: string; runs: RunSummary[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const { data, error: detailError, mutate: reloadDetail } = useSWR<{ run: AgentRun }>(
    selected ? `/api/exhibitions/${exhibitionId}/runs/${selected}` : null,
    jsonFetcher,
  );

  const latestWorkflowId = [...runs].reverse().find((r) => r.workflow_id)?.workflow_id ?? null;
  const current = latestWorkflowId ? runs.filter((r) => r.workflow_id === latestWorkflowId) : runs;
  const history = latestWorkflowId ? runs.filter((r) => r.workflow_id !== latestWorkflowId) : [];
  const sourceLabel = outputSourceLabel(data?.run.output_json);

  async function retryFailed() {
    setRetryBusy(true);
    setRetryError(null);
    try {
      const res = await fetch(apiUrl(`/api/exhibitions/${exhibitionId}/runs/retry`), { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? "重试失败");
      setSelected(null);
      mutate(`/api/exhibitions/${exhibitionId}/status`);
    } catch (e) {
      setRetryError(e instanceof Error ? e.message : "重试失败");
    } finally {
      setRetryBusy(false);
    }
  }

  if (runs.length === 0) {
    return (
      <p className="text-xs text-muted">还没有策展记录。上传照片后开始分析，这里会显示每个智能体的工作轨迹。</p>
    );
  }

  return (
    <div>
      <ul className="space-y-1">
        {current.map((r) => (
          <li key={r.id}>
            <RunRow run={r} onOpen={() => { setRetryError(null); setSelected(r.id); }} />
          </li>
        ))}
      </ul>

      {history.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer px-2 text-xs text-muted hover:text-text">
            历史处理记录（{history.length} 次）
          </summary>
          <ul className="mt-1 space-y-1 opacity-70">
            {history.map((r) => (
              <li key={r.id}>
                <RunRow run={r} onOpen={() => { setRetryError(null); setSelected(r.id); }} />
              </li>
            ))}
          </ul>
        </details>
      )}

      {selected && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-6 backdrop-blur-sm"
          onClick={() => setSelected(null)}
        >
          <div
            className="card max-h-[80vh] w-full max-w-2xl overflow-auto p-6"
            onClick={(e) => e.stopPropagation()}
          >
            {detailError ? (
              <div role="alert">
                <p className="mb-3 text-sm text-error">运行记录加载失败，请重试；不会重新执行模型调用。</p>
                <Button variant="outline" onClick={() => void reloadDetail()}>重新加载记录</Button>
                <Button variant="ghost" onClick={() => setSelected(null)}>关闭</Button>
              </div>
            ) : !data ? (
              <Spinner label="加载运行记录" />
            ) : (
              <>
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="font-display text-lg text-text">
                    {AGENT_LABEL[data.run.agent_type] ?? data.run.agent_type}
                  </h3>
                  <button
                    type="button"
                    className="text-muted hover:text-text"
                    onClick={() => setSelected(null)}
                  >
                    ✕
                  </button>
                </div>
                <div className="mb-4 flex flex-wrap gap-2 text-xs text-muted">
                  <Badge tone={data.run.status === "failed" ? "error" : "ok"}>
                    {STATUS_LABEL[data.run.status] ?? data.run.status}
                  </Badge>
                  {data.run.duration_ms != null && <span>耗时 {(data.run.duration_ms / 1000).toFixed(2)}s</span>}
                  <span>输入版本 v{data.run.input_version}</span>
                </div>
                {data.run.error_message && (
                  <p className="mb-4 rounded-md border border-error/40 bg-error/10 px-3 py-2 text-sm text-error">
                    {data.run.error_message}
                  </p>
                )}
                {sourceLabel && <p className="mb-4"><Badge tone="muted">{sourceLabel}</Badge></p>}
                <details>
                  <summary className="cursor-pointer text-xs text-muted hover:text-text">技术细节（输入 / 输出 JSON）</summary>
                  <div className="mt-2">
                    <Section title="输入" value={data.run.input_json} />
                    <Section title="输出" value={data.run.output_json} />
                  </div>
                </details>
                {data.run.status === "failed" && (
                  <div className="mt-4">
                    <Button variant="outline" disabled={retryBusy} onClick={retryFailed}>
                      {retryBusy ? <Spinner label="重试中" /> : "重试这一步"}
                    </Button>
                    {retryError && <p className="mt-2 text-sm text-error">{retryError}</p>}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, value }: { title: string; value: unknown }) {
  if (value == null) return null;
  return (
    <div className="mb-4">
      <div className="mb-1 text-xs uppercase tracking-wider text-muted">{title}</div>
      <pre className="max-h-64 overflow-auto rounded-md bg-ink px-3 py-2 text-xs leading-relaxed text-text/90">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
"use client";

import { apiUrl } from "@/lib/appBase";
import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { mutate } from "swr";
import { useStatus } from "@/lib/hooks";
import { STAGE_META, stagesBetween, stageIndex, type Stage } from "@/lib/orchestrator/stateMachine";
import { Button, Spinner } from "@/components/ui";
import { requestId } from "@/lib/uuid";

const JSON_HEADERS = { "content-type": "application/json" };

/**
 * 全局 stale / 失败横幅（§7.3 重跑矩阵 + §19.1 F 普通用户语言）：
 * 编辑只标记过期，不自动重跑；「更新影展」从 stale_from 精确重跑（不越过用户确认门）；
 * 失败重试走 /runs/retry 精确修复失败阶段；技术细节默认折叠。
 */
export function StaleBanner({ exhibitionId }: { exhibitionId: string }) {
  const status = useStatus(exhibitionId);
  const pathname = usePathname();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exh = status.data?.exhibition;
  const running = status.data?.is_running ?? false;
  if (!exh) return null;

  const stale = exh.stale_from as Stage | null;
  const failed = exh.failed_stage as Stage | null;
  if (!stale && !failed) return null;

  // 保留集变化使确认失效（§19.5）：此时 /rerun 会被确认门挡住，
  // 横幅改为引导重新确认选片，而不是给一个必然失败的「更新影展」。
  const needsReconfirm =
    !failed && stale != null && exh.selection_confirmed_revision == null && stageIndex(stale) > stageIndex("select");

  async function post(url: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(body ?? {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message ?? "操作失败");
      await mutate(`/api/exhibitions/${exhibitionId}/status`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  async function switchToDemoAndRetry() {
    setBusy(true);
    setError(null);
    try {
      const patch = await fetch(apiUrl(`/api/exhibitions/${exhibitionId}`), {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ mode: "demo" }),
      });
      if (!patch.ok) throw new Error((await patch.json())?.error?.message ?? "模式切换失败");
      await post(`/api/exhibitions/${exhibitionId}/runs/ingest`, { request_id: requestId() });
    } catch (e) {
      setError(e instanceof Error ? e.message : "模式切换失败");
    } finally {
      setBusy(false);
    }
  }

  // 与后端 gateCeiling 一致：未确认选片最多到 select；未选主题最多到 motifs。
  let ceiling: Stage = "qa";
  if (exh.selection_confirmed_revision == null) ceiling = "select";
  else if (!exh.selected_motif_id && stageIndex("motifs") < stageIndex(ceiling)) ceiling = "motifs";
  const staleTo = stale && stageIndex(stale) <= stageIndex(ceiling) ? ceiling : null;
  const staleLabels =
    stale && staleTo ? stagesBetween(stale, staleTo).map((s) => STAGE_META[s].userLabel) : [];
  const failedRun = [...(status.data?.runs ?? [])].reverse().find((r) => r.status === "failed");

  return (
    <div className="mx-auto max-w-6xl px-6 pt-4">
      {failed && (
        <div className="card border-error/40 px-4 py-3 text-sm">
          <div className="flex flex-wrap items-center gap-3 text-error">
            <span>
              「{STAGE_META[failed].userLabel}」这次生成未完成，之前保存的内容仍在。
            </span>
            <span className="ml-auto flex items-center gap-2">
              {exh.mode === "ai" && (
                <Button variant="outline" className="!py-1.5 text-xs" disabled={busy || running} onClick={switchToDemoAndRetry}>
                  切换本地演示并重新分析
                </Button>
              )}
              <Button variant="outline" className="!py-1.5 text-xs" disabled={busy || running} onClick={() => post(`/api/exhibitions/${exhibitionId}/runs/retry`)}>
                {busy || running ? <Spinner label="重试中…" /> : "重试这一步"}
              </Button>
            </span>
          </div>
          {failedRun?.error_message && <p className="mt-2 text-sm text-text">{failedRun.error_message}</p>}
          {exh.mode === "ai" && <Link href={`/e/${exhibitionId}/material#ai-settings`} className="mt-2 inline-block text-xs text-gold">检查模式、授权与连接状态</Link>}
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-muted hover:text-text">查看技术细节</summary>
            <p className="mt-1 text-xs text-muted">
              失败阶段：{failed}
              {failedRun && <> · 运行 {failedRun.id}</>}
              {failedRun?.error_message && <> · {failedRun.error_message}</>}
            </p>
          </details>
        </div>
      )}
      {needsReconfirm && (
        <div className="card border-warn/40 px-4 py-3 text-sm">
          <div className="flex flex-wrap items-center gap-3 text-warn">
            <span>照片选择已保存。影展需要同步这次修改，请先重新确认选片。</span>
            {pathname !== `/e/${exhibitionId}/selection` && (
              <span className="ml-auto">
                <Link href={`/e/${exhibitionId}/selection`} className="btn btn-outline !py-1.5 text-xs">
                  重新确认选片
                </Link>
              </span>
            )}
          </div>
        </div>
      )}
      {!failed && stale && !needsReconfirm && (
        <div className="card border-warn/40 px-4 py-3 text-sm">
          <div className="flex flex-wrap items-center gap-3 text-warn">
            <span>
              你的修改还没有应用到影展。点击「更新影展」，重新生成受影响的部分
              {staleLabels.length > 0 && <>（{staleLabels.join(" → ")}）</>}。
            </span>
            <span className="ml-auto">
              <Button variant="outline" className="!py-1.5 text-xs" disabled={busy || running} onClick={() => post(`/api/exhibitions/${exhibitionId}/rerun`)}>
                {busy || running ? <Spinner label="更新中…" /> : "更新影展"}
              </Button>
            </span>
          </div>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-muted hover:text-text">查看技术细节</summary>
            <p className="mt-1 text-xs text-muted">stale_from：{stale}（重跑不越过你的确认门）</p>
          </details>
        </div>
      )}
      {error && <div className="card mt-2 border-error/40 px-4 py-2 text-sm text-error">{error}</div>}
    </div>
  );
}
"use client";

import { apiUrl } from "@/lib/appBase";
import { useRef, useState } from "react";
import { useStatus } from "@/lib/hooks";
import { Button, Spinner } from "./ui";
import { AiUsagePanel } from "./AiUsagePanel";

export function AiExhibitionSettings({ exhibitionId }: { exhibitionId: string }) {
  const { data, mutate } = useStatus(exhibitionId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const exhibition = data?.exhibition;
  if (!exhibition) return null;

  async function save(suffix: string, body: unknown) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const res = await fetch(apiUrl(`/api/exhibitions/${exhibitionId}${suffix}`), {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result?.error?.message ?? "设置未保存，请重试。");
      await mutate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "设置未保存，请重试。");
    } finally {
      pending.current = false; setBusy(false);
    }
  }

  return (
    <section id="ai-settings" className="card mb-6 space-y-3 p-4 text-sm">
      <h2 className="font-medium text-text">运行模式与外部处理授权</h2>
      <div className="flex flex-wrap items-center gap-2">
        <span>当前：{exhibition.mode === "ai" ? "AI 模式" : "本地演示"}</span>
        <Button variant="outline" disabled={busy || data.is_running} onClick={() => void save("", { mode: exhibition.mode === "ai" ? "demo" : "ai" })}>
          切换为{exhibition.mode === "ai" ? "本地演示" : "AI 模式"}
        </Button>
        {busy && <Spinner label="保存设置中" />}
      </div>
      <p className="text-xs text-muted">切换模式不会删除已保存作品，也不会自动生成；旧授权将取消，之后请重新分析并确认选片。</p>
      {exhibition.mode === "ai" && (
        <>
          <label className="flex items-start gap-2 text-muted">
            <input type="checkbox" className="mt-1 accent-[#c9a86a]" checked={exhibition.allow_external_ai} disabled={busy || (data.is_running && !exhibition.allow_external_ai)} onChange={(event) => void save("/external-ai", { allow_external_ai: event.target.checked })} />
            <span>允许把压缩分析图和必要文字发送给已配置的模型服务，用于本次照片理解与策展。原图保存在本地，压缩副本仍可能包含人物等画面信息。</span>
          </label>
          <p className="text-xs text-muted">EXIF 仅用于本地整理，不外发 GPS、完整拍摄元数据或本地路径。撤销授权会停止后续外发，但无法收回已发送的数据；正在生成时仍可撤销。</p>
          {!exhibition.allow_external_ai && <p className="text-warn">未授权：可以继续保存素材，但不能开始 AI 分析。</p>}
        </>
      )}
      {error && <p role="alert" className="text-error">{error}</p>}
      <AiUsagePanel />
    </section>
  );
}

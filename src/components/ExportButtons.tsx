"use client";

import { useState } from "react";
import { Button, Spinner } from "@/components/ui";

/** 导出入口（§导出）：POST /export 取 attachment → blob 下载。HTML 单文件自包含 / JSON 全量包。 */
export function ExportButtons({ exhibitionId, className = "" }: { exhibitionId: string; className?: string }) {
  const [busy, setBusy] = useState<"html" | "json" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function download(format: "html" | "json") {
    setBusy(format);
    setError(null);
    try {
      const res = await fetch(`/api/exhibitions/${exhibitionId}/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ format }),
      });
      if (!res.ok) throw new Error((await res.json())?.error?.message ?? "导出失败");
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `afterlight-${exhibitionId}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "导出失败");
    } finally {
      setBusy(null);
    }
  }

  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <Button variant="outline" className="!px-3 !py-1.5 text-xs" disabled={busy !== null} onClick={() => download("html")}>
        {busy === "html" ? <Spinner label="导出中…" /> : "导出 HTML"}
      </Button>
      <Button variant="ghost" className="!px-3 !py-1.5 text-xs" disabled={busy !== null} onClick={() => download("json")}>
        {busy === "json" ? <Spinner label="导出中…" /> : "结构数据（高级导出）"}
      </Button>
      {error && <span className="text-xs text-error">{error}</span>}
    </span>
  );
}
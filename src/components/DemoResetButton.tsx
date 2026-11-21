"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Spinner } from "@/components/ui";
import type { Exhibition } from "@/types";

/** 首页「重置演示数据」：两步确认后删除所有 is_demo_set 影展（行 + 本机原图），不影响用户自建影展。 */
export function DemoResetButton() {
  const router = useRouter();
  const [demoIds, setDemoIds] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function open() {
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      const res = await fetch("/api/exhibitions");
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message ?? "读取影展列表失败");
      const ids = (data.exhibitions as Exhibition[])
        .filter((e) => e.is_demo_set)
        .map((e) => e.id);
      if (ids.length === 0) {
        setNote("没有演示影展需要重置");
        return;
      }
      setDemoIds(ids);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取影展列表失败");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!demoIds) return;
    setBusy(true);
    setError(null);
    try {
      for (const id of demoIds) {
        const res = await fetch(`/api/exhibitions/${id}`, { method: "DELETE" });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error?.message ?? `删除 ${id} 失败`);
        }
      }
      setDemoIds(null);
      setNote(`已重置 ${demoIds.length} 个演示影展`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "重置失败");
    } finally {
      setBusy(false);
    }
  }

  if (demoIds) {
    return (
      <div className="rounded-md border border-error/50 bg-error/10 px-4 py-3 text-sm">
        <p className="text-text">
          将删除 {demoIds.length} 个演示影展及其本机原图文件，不可恢复。你上传创建的影展不受影响。
        </p>
        <div className="mt-3 flex items-center gap-3">
          <Button variant="primary" className="!bg-error !text-text" onClick={confirm} disabled={busy}>
            {busy ? <Spinner label="重置中…" /> : "确认重置"}
          </Button>
          <Button variant="ghost" onClick={() => setDemoIds(null)} disabled={busy}>
            取消
          </Button>
        </div>
        {error && <p className="mt-2 text-xs text-error">{error}</p>}
      </div>
    );
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button variant="ghost" onClick={open} disabled={busy}>
        {busy ? <Spinner label="检查演示数据" /> : "重置演示数据"}
      </Button>
      {note && <span className="text-xs text-muted">{note}</span>}
      {error && <span className="text-xs text-error">{error}</span>}
    </span>
  );
}
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Spinner } from "@/components/ui";

/** §13.1：删除当前影展和所有图片。两步确认，不可撤销；已导出文件不受影响。 */
export function PrivacyDelete({ exhibitionId }: { exhibitionId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doDelete() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/exhibitions/${exhibitionId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? "删除失败，请重试。");
      }
      router.push("/");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败，请重试。");
      setBusy(false);
    }
  }

  return (
    <section className="card mt-12 p-5">
      <h2 className="text-sm text-muted">隐私与数据</h2>
      <p className="mt-2 text-xs leading-relaxed text-muted">
        原图与缩略图仅保存在本机数据目录，不会默认上传或公开。删除影展会一并移除本机全部原图文件；已导出的 HTML / JSON 文件不受影响。
      </p>
      {!confirming ? (
        <Button variant="outline" className="mt-3 !border-error/60 !text-error" onClick={() => setConfirming(true)}>
          删除影展与全部原图
        </Button>
      ) : (
        <div className="mt-3 rounded border border-error/50 bg-error/10 p-4">
          <p className="text-xs leading-relaxed text-text">
            此操作不可撤销：将删除该影展的照片、分析、叙事、布局、质检与历史版本，以及本机原图 / 缩略图文件。确定继续？
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Button variant="primary" className="!bg-error !text-text" disabled={busy} onClick={doDelete}>
              {busy ? <Spinner label="删除中…" /> : "确认删除"}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>取消</Button>
            {error && <span className="text-xs text-error">{error}</span>}
          </div>
        </div>
      )}
    </section>
  );
}
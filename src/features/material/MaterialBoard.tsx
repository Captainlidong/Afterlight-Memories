"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { useStatus, usePhotos, jsonFetcher } from "@/lib/hooks";
import type { AiConnectionStatus } from "@/lib/ai/status";
import { AiExhibitionSettings } from "@/components/AiExhibitionSettings";
import { useWorkflowAdvance } from "@/lib/useWorkflowAdvance";
import { UploadZone } from "./UploadZone";
import { AgentTrace } from "@/components/AgentTrace";
import { LoadError } from "@/components/LoadError";
import { Badge, Button, EmptyState, Spinner } from "@/components/ui";
import type { PhotoAsset } from "@/types";
import type { PhotoInspectionT } from "@/lib/agents/schemas";

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export type DeleteOutcome = { ok: boolean; message: string | null };

/**
 * 单张删除请求：网络失败与服务端 4xx/5xx 都不抛出，返回结构化结果给调用方反馈。
 * 服务端返回的中文业务消息（如"影展正在生成中"）原样透出；网络错误不透出英文原始信息。
 */
export async function deletePhotoRequest(
  exhibitionId: string,
  photoId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeleteOutcome> {
  try {
    const res = await fetchImpl(`/api/exhibitions/${exhibitionId}/photos/${photoId}`, { method: "DELETE" });
    if (res.ok) return { ok: true, message: null };
    const data = await res.json().catch(() => null);
    return { ok: false, message: data?.error?.message ?? null };
  } catch {
    return { ok: false, message: null };
  }
}

/** 清空：逐张删除，统计成功/失败；任何一张失败都不中断其余尝试。 */
export async function clearPhotosWithReport(
  exhibitionId: string,
  photos: { id: string }[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ removed: number; failed: number; serverMessage: string | null }> {
  let removed = 0;
  let failed = 0;
  let serverMessage: string | null = null;
  for (const p of photos) {
    const outcome = await deletePhotoRequest(exhibitionId, p.id, fetchImpl);
    if (outcome.ok) {
      removed += 1;
    } else {
      failed += 1;
      if (outcome.message && !serverMessage) serverMessage = outcome.message;
    }
  }
  return { removed, failed, serverMessage };
}

export function MaterialBoard({
  exhibitionId,
  autostart,
}: {
  exhibitionId: string;
  autostart: boolean;
}) {
  const { data: status, error: statusError, mutate: mutateStatus } = useStatus(exhibitionId);
  const { data: photoData, error: photoError, mutate: mutatePhotos } = usePhotos(exhibitionId);
  const { data: aiStatus } = useSWR<{ connection: AiConnectionStatus }>(status?.exhibition.mode === "ai" ? "/api/ai/status" : null, jsonFetcher, { revalidateOnFocus: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const { begin: beginAdvance } = useWorkflowAdvance(exhibitionId, {
    expectedStatus: "awaiting_selection_confirm",
    targetPath: `/e/${exhibitionId}/selection`,
  });

  const refresh = useCallback(() => {
    mutatePhotos();
    mutateStatus();
  }, [mutatePhotos, mutateStatus]);

  // 分析进度变化（inspected 计数 / running 标志）时同步缩略图墙状态。
  const inspectedCount = status?.photos.inspected ?? 0;
  const runningFlag = status?.is_running ?? false;
  useEffect(() => {
    mutatePhotos();
  }, [inspectedCount, runningFlag, mutatePhotos]);

  const triggerIngest = useCallback(async (requestId: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/exhibitions/${exhibitionId}/runs/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request_id: requestId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message ?? "启动分析失败");
      if (data.workflow_id) beginAdvance(data.workflow_id);
      mutateStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "启动分析失败");
    } finally {
      setBusy(false);
    }
  }, [exhibitionId, mutateStatus, beginAdvance]);

  // 演示种子落地后自动开始分析（?autostart=1）。确定性幂等键：严格模式双挂载/重试不会重复启动。
  useEffect(() => {
    if (!autostart || started.current || !status || !photoData || status.exhibition.mode !== "demo" || !status.exhibition.is_demo_set) return;
    if (photoData.photos.length > 0 && !status.is_running && status.exhibition.status === "draft") {
      started.current = true;
      // 异步启动，避免在 effect 内同步 setState（triggerIngest 以 setBusy 开始）。
      queueMicrotask(() => void triggerIngest(`ingest-autostart-${exhibitionId}`));
    }
  }, [autostart, status, photoData, triggerIngest, exhibitionId]);

  async function removePhoto(photoId: string) {
    const outcome = await deletePhotoRequest(exhibitionId, photoId);
    if (!outcome.ok) {
      setError(outcome.message ?? "删除失败，请检查网络后重试。");
    }
    refresh();
  }

  async function clearAll() {
    if (!photoData || photoData.photos.length === 0) return;
    if (!window.confirm(`确定清空全部 ${photoData.photos.length} 张照片？此操作不可撤销。`)) return;
    setBusy(true);
    setError(null);
    try {
      const report = await clearPhotosWithReport(exhibitionId, photoData.photos);
      if (report.failed > 0) {
        setError(report.serverMessage
          ? `清空未完成：已删除 ${report.removed} 张，${report.failed} 张没有删除成功。${report.serverMessage}`
          : report.removed === 0
            ? "清空失败：服务没有响应，请检查网络后重试。照片都还在，没有被删除。"
            : `清空未完成：已删除 ${report.removed} 张，${report.failed} 张没有删除成功。请检查网络后重试。`);
      }
    } finally {
      // 网络失败也不能把界面留在加载态：退出 busy、刷新真实列表。
      setBusy(false);
      refresh();
    }
  }

  const photos = photoData?.photos ?? [];
  const inspections = new Map<string, PhotoInspectionT>(
    (photoData?.inspections ?? []).map((i) => [i.photo_id, i]),
  );
  const totalSize = photos.reduce((s, p) => s + p.file_size, 0);
  const running = status?.is_running ?? false;
  const aiBlocked = status?.exhibition.mode === "ai" && (!status.exhibition.allow_external_ai || !aiStatus?.connection.canTest);
  const canAnalyze = photos.length > 0 && !running && !busy && !aiBlocked;
  const selectionReady = status?.exhibition.status === "awaiting_selection_confirm";

  if (statusError && !status) {
    return <LoadError message="无法加载影展状态，请检查网络后重试。" onRetry={() => mutateStatus()} />;
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl text-text">上传照片</h1>
          <p className="mt-1 text-sm text-muted">
            {photos.length > 0
              ? `${photos.length} 张 · ${fmtSize(totalSize)}`
              : "还没有照片。技术分析只是后续判断的证据，不会替你删除任何一张。"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {photos.length > 0 && (
            <Button variant="ghost" onClick={clearAll} disabled={busy || running}>
              清空
            </Button>
          )}
          {selectionReady && !running ? (
            <Link href={`/e/${exhibitionId}/selection`} className="btn btn-primary">
              去确认选片 →
            </Link>
          ) : (
            <Button onClick={() => triggerIngest(crypto.randomUUID())} disabled={!canAnalyze}>
              {running ? <Spinner label="分析中" /> : busy ? <Spinner label="启动中" /> : "分析照片并推荐选片"}
            </Button>
          )}
        </div>
      </div>

      <AiExhibitionSettings exhibitionId={exhibitionId} />
      {aiBlocked && <p className="mb-4 text-sm text-warn">AI 分析尚不可用，请先检查上方配置与授权。仍可上传并保存素材。</p>}
      {running && !status?.ai_usage && <p role="status" className="mb-4 text-sm text-gold">已保存分析 {inspectedCount}/{status?.photos.total ?? photos.length} 张 · 当前失败 {status?.photos.failed ?? 0} 张。正在处理，完成后请确认选片；此计数包含之前保存的结果。</p>}
      {error && <p role="alert" className="mb-4 text-sm text-error">{error}</p>}

      <div className="grid gap-8 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <UploadZone exhibitionId={exhibitionId} onUploaded={refresh} />

          {photoError && !photoData ? (
            <div className="mt-6">
              <LoadError message="无法加载照片列表，请检查网络后重试。" onRetry={() => mutatePhotos()} />
            </div>
          ) : photos.length === 0 ? (
            <div className="mt-6">
              <EmptyState
                title="素材为空"
                description="把一组照片拖进来，留影会先读取尺寸、EXIF、清晰度与重复关系——但不会急着替你删除任何一张。"
              />
            </div>
          ) : (
            <ul className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
              {photos.map((p) => (
                <PhotoTile
                  key={p.id}
                  photo={p}
                  inspection={inspections.get(p.id)}
                  exhibitionId={exhibitionId}
                  onDelete={() => removePhoto(p.id)}
                />
              ))}
            </ul>
          )}
        </div>

        <aside className="card h-fit p-5">
          <h2 className="mb-3 text-xs uppercase tracking-[0.2em] text-muted">智能体轨迹</h2>
          <AgentTrace
            exhibitionId={exhibitionId}
            runs={status?.runs ?? []}
          />
        </aside>
      </div>
    </div>
  );
}

function PhotoTile({
  photo,
  inspection,
  exhibitionId,
  onDelete,
}: {
  photo: PhotoAsset;
  inspection?: PhotoInspectionT;
  exhibitionId: string;
  onDelete: () => void;
}) {
  const ratio = photo.width && photo.height ? photo.width / photo.height : 1;
  return (
    <li className="group relative">
      <div
        className="relative overflow-hidden rounded-md border border-ink-line bg-ink-soft"
        style={{ aspectRatio: String(ratio) }}
      >
        {photo.thumbnail_path ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/files/${exhibitionId}/${photo.id}?variant=thumb`}
            alt={photo.original_name}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-error">损坏</div>
        )}
        <button
          type="button"
          onClick={onDelete}
          title="删除这张"
          className="absolute right-1.5 top-1.5 hidden h-6 w-6 items-center justify-center rounded-full bg-ink/80 text-xs text-muted hover:text-error group-hover:flex"
        >
          ✕
        </button>
      </div>
      <div className="mt-1.5 truncate text-xs text-text" title={photo.original_name}>
        {photo.original_name}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {photo.width && photo.height && (
          <span className="text-[10px] text-muted">
            {photo.width}×{photo.height}
          </span>
        )}
        {photo.status === "inspected" && <Badge tone="ok">已分析</Badge>}
        {photo.status === "uploaded" && <Badge>待分析</Badge>}
        {photo.status === "failed" && <Badge tone="error">失败</Badge>}
        {photo.has_exif && <Badge tone="gold">EXIF</Badge>}
        {inspection?.duplicate_group_id && <Badge tone="warn">重复</Badge>}
      </div>
    </li>
  );
}
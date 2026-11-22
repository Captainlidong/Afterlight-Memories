"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useStatus, usePhotos, useMotifs } from "@/lib/hooks";
import { useWorkflowAdvance } from "@/lib/useWorkflowAdvance";
import { useLandingFocus } from "@/lib/useLandingFocus";
import { AgentTrace } from "@/components/AgentTrace";
import { LoadError } from "@/components/LoadError";
import { Badge, Button, EmptyState, Spinner } from "@/components/ui";
import type { PhotoAsset, MotifDTO } from "@/types";
import { requestId } from "@/lib/uuid";

export function MotifsBoard({ exhibitionId }: { exhibitionId: string }) {
  const [headingRef, landingMessage] = useLandingFocus(exhibitionId, "选择主题");
  const { data: status, error: statusError, mutate: mutateStatus } = useStatus(exhibitionId);
  const { data: photoData } = usePhotos(exhibitionId);
  const running = status?.is_running ?? false;
  const { data: motifData, error: motifError, isLoading: motifsLoading, isValidating: motifsValidating, mutate: mutateMotifs } = useMotifs(exhibitionId, running);
  const { begin: beginAdvance } = useWorkflowAdvance(exhibitionId, {
    expectedStatus: "awaiting_user_review",
    targetPath: `/e/${exhibitionId}/narrative`,
  });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const photos = photoData?.photos ?? [];
  const photoById = new Map(photos.map((p) => [p.id, p]));
  const motifs = motifData?.motifs ?? [];
  const inspectedCount = status?.photos.inspected ?? 0;
  const selectedId = status?.exhibition.selected_motif_id ?? null;
  const selectedMotif = motifs.find((m) => m.id === selectedId);
  const selectionConfirmed = status?.exhibition.selection_confirmed_revision != null;
  const hasNarrative = status?.progress.narrative ?? false;
  // status.runs 按创建时间升序；只看最新主题运行，不能拿旧成功掩盖新失败。
  const latestMotifRun = [...(status?.runs ?? [])].reverse().find((r) => r.agent_type === "motif_finder");
  const discovering = running || latestMotifRun?.status === "running" || latestMotifRun?.status === "pending";
  const loadingMotifs = motifsLoading || motifsValidating || !motifData || !status;
  const insufficient = motifs.length === 0 && latestMotifRun?.status === "completed"
    && !discovering && !busy && !loadingMotifs && !motifError && !statusError && !error;
  const canDiscover = selectionConfirmed && photos.length > 0 && inspectedCount > 0 && !discovering && !busy;

  const run = useCallback(
    async (url: string, init?: RequestInit, failMsg = "操作失败") => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(url, init);
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error?.message ?? failMsg);
        mutateMotifs();
        mutateStatus();
      } catch (err) {
        setError(err instanceof Error ? err.message : failMsg);
      } finally {
        setBusy(false);
      }
    },
    [mutateMotifs, mutateStatus],
  );

  const discover = useCallback(
    () => run(
      `/api/exhibitions/${exhibitionId}/runs/motifs`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request_id: requestId() }) },
      "启动主题发现失败",
    ),
    [exhibitionId, run],
  );
  const choose = useCallback(
    (motifId: string) =>
      run(
        `/api/exhibitions/${exhibitionId}/motifs/select`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ motif_id: motifId }) },
        "选择主线失败",
      ),
    [exhibitionId, run],
  );
  const rename = useCallback(
    (motifId: string, title: string) =>
      run(
        `/api/exhibitions/${exhibitionId}/motifs/${motifId}`,
        { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) },
        "改名失败",
      ),
    [exhibitionId, run],
  );
  const reject = useCallback(
    (motifId: string) =>
      run(
        `/api/exhibitions/${exhibitionId}/motifs/${motifId}`,
        { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: "rejected" }) },
        "拒绝主题失败",
      ),
    [exhibitionId, run],
  );

  const generate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/exhibitions/${exhibitionId}/runs/narrative`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request_id: requestId() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message ?? "生成影展失败");
      if (data.workflow_id) beginAdvance(data.workflow_id);
      mutateStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成影展失败");
    } finally {
      setBusy(false);
    }
  }, [exhibitionId, beginAdvance, mutateStatus]);

  const previewPhoto = preview ? photoById.get(preview) : undefined;

  if (statusError && !status) {
    return <LoadError message="无法加载影展状态，请检查网络后重试。" onRetry={() => mutateStatus()} />;
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          {landingMessage && <p role="status" aria-live="polite" className="sr-only">{landingMessage}</p>}
          <h1 ref={headingRef} tabIndex={-1} className="font-display text-2xl text-text outline-none">选择主题</h1>
          <p className="mt-1 text-sm text-muted">
            {motifs.length > 0
              ? `在保留照片里找到 ${motifs.length} 个候选母题。选一条主线，或改名、拒绝、重新发现——观看方式由你定。`
              : "主题发现官在保留照片里寻找反复出现的颜色、构图与空间关系，提出带证据的母题，而不是只按日期地点分类。"}
          </p>
        </div>
        <Button variant="outline" onClick={discover} disabled={!canDiscover}>
          {discovering ? <Spinner label="发现中" /> : busy ? <Spinner label="处理中" /> : motifs.length > 0 || insufficient ? "重新发现" : "开始主题发现"}
        </Button>
      </div>

      {error && <p className="mb-4 text-sm text-error">{error}</p>}

      {selectedMotif && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-md border border-gold/40 bg-gold/10 px-4 py-3">
          <span className="text-sm text-text">
            已选主线：<span className="font-display text-gold">{selectedMotif.effective_title}</span>
          </span>
          {hasNarrative ? (
            <Link href={`/e/${exhibitionId}/narrative`} className="btn btn-primary">
              去调整内容 →
            </Link>
          ) : (
            <Button disabled={busy || running} onClick={generate}>
              {busy || running ? <Spinner label="生成中" /> : "用这个主题生成影展"}
            </Button>
          )}
        </div>
      )}

      <div className="grid gap-8 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {motifError ? (
            <LoadError message="无法加载候选主题，请检查网络后重试。" onRetry={() => mutateMotifs()} />
          ) : motifs.length === 0 && (loadingMotifs || discovering || busy) ? (
            <div className="card px-6 py-16 text-center" role="status">
              <Spinner label={discovering ? "正在发现主题" : busy ? "正在处理" : "加载候选主题"} />
            </div>
          ) : motifs.length === 0 ? (
            <EmptyState
              title={
                !selectionConfirmed ? "请先确认选片"
                  : insufficient ? "当前素材不足以支持主题"
                    : latestMotifRun?.status === "failed" ? "主题发现未完成"
                      : inspectedCount > 0 ? "还没有候选主题" : "请先完成素材分析与筛选"
              }
              description={
                !selectionConfirmed
                  ? "主题发现只使用你确认保留的照片。回到选片页，确认哪些照片进入影展后再继续。"
                  : insufficient
                    ? "本次未找到有足够证据的候选主题。请调整选片或策展意图，再重新发现。"
                    : latestMotifRun?.status === "failed"
                      ? "上次主题发现失败，请重试或查看智能体轨迹中的错误信息。"
                      : inspectedCount > 0
                        ? "主题发现官会根据保留照片的构图、色温与空间关系提出最多 4 个带证据的候选母题；证据不足时可能只有 1 个或没有主题，不强行凑数。"
                        : "回到素材页运行素材管家、再到筛选页保留一些照片，然后开始主题发现。"
              }
              action={
                !selectionConfirmed ? (
                  <Link href={`/e/${exhibitionId}/selection`} className="btn btn-primary">去确认选片 →</Link>
                ) : insufficient ? (
                  <div className="flex flex-wrap justify-center gap-2">
                    <Link href={`/e/${exhibitionId}/selection`} className="btn btn-outline">调整选片</Link>
                    <Button onClick={discover} disabled={!canDiscover}>重新发现</Button>
                  </div>
                ) : inspectedCount > 0 ? (
                  <Button onClick={discover} disabled={!canDiscover}>{latestMotifRun?.status === "failed" ? "重试主题发现" : "开始主题发现"}</Button>
                ) : undefined
              }
            />
          ) : (
            <ul className="grid gap-5 sm:grid-cols-2">
              {motifs.map((m) => (
                <MotifCard
                  key={m.id}
                  motif={m}
                  exhibitionId={exhibitionId}
                  photoById={photoById}
                  busy={busy}
                  isSelected={m.id === selectedId}
                  onChoose={() => choose(m.id)}
                  onRename={(title) => rename(m.id, title)}
                  onReject={() => reject(m.id)}
                  onPreview={(id) => setPreview(id)}
                />
              ))}
            </ul>
          )}
        </div>

        <aside className="card h-fit p-5">
          <h2 className="mb-3 text-xs uppercase tracking-[0.2em] text-muted">智能体轨迹</h2>
          <AgentTrace exhibitionId={exhibitionId} runs={status?.runs ?? []} />
        </aside>
      </div>

      {previewPhoto && (
        <PhotoPreview
          photo={previewPhoto}
          exhibitionId={exhibitionId}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

function MotifCard({
  motif,
  exhibitionId,
  photoById,
  busy,
  isSelected,
  onChoose,
  onRename,
  onReject,
  onPreview,
}: {
  motif: MotifDTO;
  exhibitionId: string;
  photoById: Map<string, PhotoAsset>;
  busy: boolean;
  isSelected: boolean;
  onChoose: () => void;
  onRename: (title: string) => void;
  onReject: () => void;
  onPreview: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(motif.effective_title);
  const evidencePhotos = motif.photo_ids
    .map((id) => photoById.get(id))
    .filter((p): p is PhotoAsset => Boolean(p))
    .slice(0, 6);

  const save = () => {
    const t = draft.trim();
    if (t && t !== motif.effective_title) onRename(t);
    setEditing(false);
  };

  return (
    <li className={`card flex flex-col p-5 ${isSelected ? "border-gold/50" : ""} ${motif.state === "rejected" ? "opacity-60" : ""}`}>
      <div className="mb-2 flex items-start justify-between gap-2">
        {editing ? (
          <div className="flex flex-1 items-center gap-2">
            <input
              autoFocus
              value={draft}
              maxLength={60}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
              className="flex-1 rounded-md border border-ink-line bg-ink px-2 py-1 text-sm text-text outline-none focus:border-gold/50"
            />
            <Button variant="ghost" onClick={save}>保存</Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>取消</Button>
          </div>
        ) : (
          <>
            <h3 className="font-display text-lg leading-snug text-text">{motif.effective_title}</h3>
            <button
              type="button"
              title="改名"
              className="text-muted hover:text-gold"
              onClick={() => { setDraft(motif.effective_title); setEditing(true); }}
            >
              ✎
            </button>
          </>
        )}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {isSelected ? <Badge tone="gold">主线</Badge> : motif.state === "rejected" ? <Badge tone="muted">已拒绝</Badge> : <Badge tone="muted">候选</Badge>}
        {motif.user_title && <span className="text-[11px] text-gold">已改名</span>}
        <span className="text-[11px] text-muted">置信度 {Math.round(motif.confidence * 100)}%</span>
      </div>

      <p className="mb-3 text-sm leading-relaxed text-text/90">{motif.description}</p>

      {evidencePhotos.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {evidencePhotos.map((p) => (
            <button
              key={p.id}
              type="button"
              title={p.original_name}
              onClick={() => onPreview(p.id)}
              className="h-14 w-14 overflow-hidden rounded-md border border-ink-line hover:border-gold/50"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/files/${exhibitionId}/${p.id}?variant=thumb`}
                alt={p.original_name}
                loading="lazy"
                className="h-full w-full object-cover"
              />
            </button>
          ))}
        </div>
      )}

      <div className="mb-3">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">证据</div>
        <ul className="space-y-1">
          {motif.evidence.map((e, i) => (
            <li key={i} className="flex gap-2 text-xs leading-relaxed text-text/80">
              <span className="text-gold">·</span><span>{e}</span>
            </li>
          ))}
        </ul>
      </div>

      {motif.alternative_readings.length > 0 && (
        <div className="mb-4">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">替代理解</div>
          <ul className="space-y-1">
            {motif.alternative_readings.map((a, i) => (
              <li key={i} className="text-xs italic leading-relaxed text-muted">{a}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-auto flex flex-wrap gap-2 border-t border-ink-line pt-3">
        <Button variant={isSelected ? "outline" : "primary"} disabled={busy || isSelected} onClick={onChoose}>
          {isSelected ? "已是主线" : "选为主线"}
        </Button>
        {motif.state !== "rejected" && (
          <Button variant="ghost" disabled={busy} onClick={onReject}>拒绝</Button>
        )}
      </div>
    </li>
  );
}

function PhotoPreview({
  photo,
  exhibitionId,
  onClose,
}: {
  photo: PhotoAsset;
  exhibitionId: string;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/90 p-4 backdrop-blur-sm sm:p-8"
      onClick={onClose}
    >
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex w-full items-center justify-between">
          <span className="truncate text-sm text-text">{photo.original_name}</span>
          <button type="button" className="text-muted hover:text-text" onClick={onClose}>✕</button>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/files/${exhibitionId}/${photo.id}?variant=original`}
          alt={photo.original_name}
          className="max-h-[78vh] w-auto rounded-md border border-ink-line object-contain"
        />
      </div>
    </div>
  );
}
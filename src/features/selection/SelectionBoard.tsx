"use client";

import { apiUrl } from "@/lib/appBase";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useStatus, usePhotos, useCuration, invalidateExhibition } from "@/lib/hooks";
import { useWorkflowAdvance } from "@/lib/useWorkflowAdvance";
import { useLandingFocus } from "@/lib/useLandingFocus";
import { markLandingFocus } from "@/lib/landingFocus";
import { selectionReducer } from "./batchSelection";
import { AgentTrace } from "@/components/AgentTrace";
import { LoadError } from "@/components/LoadError";
import { Badge, Button, EmptyState, Spinner } from "@/components/ui";
import type { PhotoAsset, CurationDecisionDTO } from "@/types";
import type { PhotoInspectionT, UserDecisionT } from "@/lib/agents/schemas";
import { requestId } from "@/lib/uuid";

type Tab = "keep" | "hold" | "remove";
type BatchAction = "set_decision" | "restore_ai_suggestion";

const TABS: { key: Tab; label: string; hint: string }[] = [
  { key: "keep", label: "推荐保留", hint: "进入影展的候选" },
  { key: "hold", label: "暂缓决定", hint: "交给你判断" },
  { key: "remove", label: "建议移除", hint: "冗余或明显劣化" },
];

const DECISION_LABEL: Record<UserDecisionT, string> = {
  keep: "保留",
  hold: "暂缓",
  remove: "移除",
  must_keep: "必须保留",
};

const JSON_HEADERS = { "content-type": "application/json" };

function inTab(d: CurationDecisionDTO, tab: Tab): boolean {
  const e = d.effective_decision;
  if (tab === "keep") return e === "keep" || e === "must_keep";
  return e === tab;
}

interface PendingBatch {
  ids: string[];
  action: BatchAction;
  decision?: UserDecisionT;
}

interface Snack {
  message: string;
  undoId?: string;
  viewKeep?: boolean;
}

export function SelectionBoard({ exhibitionId }: { exhibitionId: string }) {
  const router = useRouter();
  const [headingRef, landingMessage] = useLandingFocus(exhibitionId, "确认选片");
  const { data: status, error: statusError, mutate: mutateStatus } = useStatus(exhibitionId);
  const { data: photoData, mutate: mutatePhotos } = usePhotos(exhibitionId);
  const running = status?.is_running ?? false;
  const { data: curation, error: curationError, mutate: mutateCuration } = useCuration(exhibitionId, running);
  const { begin: beginAdvance } = useWorkflowAdvance(exhibitionId, {
    expectedStatus: "awaiting_theme_choice",
    targetPath: `/e/${exhibitionId}/motifs`,
  });

  const [tab, setTab] = useState<Tab>("keep");
  const [checked, dispatch] = useReducer(selectionReducer, [] as string[]);
  const [openPhoto, setOpenPhoto] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingBatch, setPendingBatch] = useState<PendingBatch | null>(null);
  const [snack, setSnack] = useState<Snack | null>(null);
  const [tabHint, setTabHint] = useState<string | null>(null);

  const photos = photoData?.photos ?? [];
  const photoById = new Map(photos.map((p) => [p.id, p]));
  const inspections = new Map<string, PhotoInspectionT>(
    (photoData?.inspections ?? []).map((i) => [i.photo_id, i]),
  );
  const decisionList = curation?.decisions;
  const decisions = useMemo(() => decisionList ?? [], [decisionList]);
  const decisionById = useMemo(() => new Map(decisions.map((d) => [d.photo_id, d])), [decisions]);

  // 分析/筛选进度变化时同步照片墙（缩略图与指标）。
  const inspectedCount = status?.photos.inspected ?? 0;
  useEffect(() => {
    mutatePhotos();
  }, [inspectedCount, running, mutatePhotos]);

  // 后台删除/刷新后剔除已不存在的勾选，避免批量提交非法 ID。
  useEffect(() => {
    if (decisionList) dispatch({ type: "prune", valid: decisionList.map((d) => d.photo_id) });
  }, [decisionList]);

  useEffect(() => {
    if (!snack) return;
    const t = setTimeout(() => setSnack(null), 9000);
    return () => clearTimeout(t);
  }, [snack]);

  useEffect(() => {
    if (!tabHint) return;
    const t = setTimeout(() => setTabHint(null), 4000);
    return () => clearTimeout(t);
  }, [tabHint]);

  const switchTab = (t: Tab) => {
    if (t === tab) return;
    setTab(t);
    dispatch({ type: "clear" });
    setTabHint("已切换分组，勾选已清空");
  };

  const triggerSelect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/api/exhibitions/${exhibitionId}/runs/select`), {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ request_id: requestId() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message ?? "启动筛选失败");
      mutateStatus();
      mutateCuration();
    } catch (err) {
      setError(err instanceof Error ? err.message : "启动筛选失败");
    } finally {
      setBusy(false);
    }
  }, [exhibitionId, mutateStatus, mutateCuration]);

  const decide = useCallback(
    async (photoId: string, decision: UserDecisionT) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(
          apiUrl(`/api/exhibitions/${exhibitionId}/photos/${photoId}/decision`),
          {
            method: "PATCH",
            headers: JSON_HEADERS,
            body: JSON.stringify({ decision }),
          },
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error?.message ?? "更新决定失败");
        await invalidateExhibition(exhibitionId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "更新决定失败");
      } finally {
        setBusy(false);
      }
    },
    [exhibitionId],
  );

  /** 服务端单事务批量（§19.5）。失败保留勾选便于重试；成功清空勾选并留在当前分组。 */
  const runBatch = useCallback(
    async (ids: string[], action: BatchAction, decision: UserDecisionT | undefined, includeMustKeep: boolean) => {
      if (!status || ids.length === 0) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(apiUrl(`/api/exhibitions/${exhibitionId}/curation/batch`), {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            photo_ids: ids,
            action,
            ...(decision ? { decision } : {}),
            include_must_keep: includeMustKeep,
            expected_revision: status.exhibition.input_revision,
            request_id: requestId(),
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error?.message ?? "批量操作失败");
        dispatch({ type: "clear" });
        const changed = (data.changed_ids as string[]).length;
        const skipped = (data.skipped_ids as string[]).length;
        setSnack({
          message: skipped > 0 ? `已更改 ${changed} 张，跳过 ${skipped} 张必须保留` : `已更改 ${changed} 张`,
          undoId: data.operation_id ?? undefined,
          viewKeep: changed > 0,
        });
        await invalidateExhibition(exhibitionId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "批量操作失败");
        await invalidateExhibition(exhibitionId);
      } finally {
        setBusy(false);
      }
    },
    [exhibitionId, status],
  );

  /** 点击时固定作用范围；涉及 must_keep 时先弹保护选择（二次确认）。 */
  const requestBatch = useCallback(
    (ids: string[], action: BatchAction, decision?: UserDecisionT) => {
      if (ids.length === 0) return;
      const hasMustKeep = ids.some((id) => decisionById.get(id)?.effective_decision === "must_keep");
      const liftsProtection = action === "restore_ai_suggestion" || decision !== "must_keep";
      if (hasMustKeep && liftsProtection) {
        setPendingBatch({ ids: [...ids], action, decision });
      } else {
        runBatch(ids, action, decision, false);
      }
    },
    [decisionById, runBatch],
  );

  const undoOperation = useCallback(
    async (opId: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(apiUrl(`/api/exhibitions/${exhibitionId}/curation/operations/${opId}/undo`), {
          method: "POST",
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error?.message ?? "撤销失败");
        setSnack({ message: `已撤销，恢复 ${(data.restored_ids as string[]).length} 张照片的原来决定` });
        await invalidateExhibition(exhibitionId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "撤销失败");
        await invalidateExhibition(exhibitionId);
      } finally {
        setBusy(false);
      }
    },
    [exhibitionId],
  );

  const confirmSelection = useCallback(
    async (holdPolicy: "exclude" | "include") => {
      if (!status) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(apiUrl(`/api/exhibitions/${exhibitionId}/curation/confirm`), {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            expected_revision: status.exhibition.input_revision,
            hold_policy: holdPolicy,
            discover_motifs: true,
            request_id: requestId(),
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error?.message ?? "确认选片失败");
        setConfirmOpen(false);
        if (data.workflow_id) beginAdvance(data.workflow_id);
        else if (data.reused_motifs) {
          markLandingFocus(sessionStorage, exhibitionId);
          router.replace(`/e/${exhibitionId}/motifs`);
        }
        await invalidateExhibition(exhibitionId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "确认选片失败");
        mutateStatus();
      } finally {
        setBusy(false);
      }
    },
    [exhibitionId, status, beginAdvance, mutateStatus, router],
  );

  const fallbackCounts = {
    keep: decisions.filter((d) => d.effective_decision === "keep").length,
    hold: decisions.filter((d) => d.effective_decision === "hold").length,
    remove: decisions.filter((d) => d.effective_decision === "remove").length,
    must_keep: decisions.filter((d) => d.effective_decision === "must_keep").length,
  };
  const counts = curation?.counts ?? fallbackCounts;
  const keepTotal = counts.keep + counts.must_keep;
  const tabCount: Record<Tab, number> = { keep: keepTotal, hold: counts.hold, remove: counts.remove };
  const visible = decisions.filter((d) => inTab(d, tab));
  const visibleIds = visible.map((d) => d.photo_id);
  const canSelect = photos.length > 0 && inspectedCount > 0 && !running && !busy;
  const openDecision = openPhoto ? decisionById.get(openPhoto) : undefined;
  const confirmed = status?.exhibition.selection_confirmed_revision != null;
  const canConfirm = decisions.length > 0 && keepTotal > 0 && !running && !busy && !!status;
  const undoOp = curation?.latest_undoable_operation ?? null;
  const acceptAndContinue = () => (counts.hold > 0 ? setConfirmOpen(true) : confirmSelection("exclude"));

  if (statusError && !status) {
    return <LoadError message="无法加载影展状态，请检查网络后重试。" onRetry={() => mutateStatus()} />;
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          {landingMessage && <p role="status" aria-live="polite" className="sr-only">{landingMessage}</p>}
          <h1 ref={headingRef} tabIndex={-1} className="font-display text-2xl text-text outline-none">确认选片</h1>
          <p className="mt-1 text-sm text-muted">
            {decisions.length > 0
              ? `${decisions.length} 张 → 保留 ${keepTotal}（必留 ${counts.must_keep}）· 暂缓 ${counts.hold} · 本次不选 ${counts.remove}`
              : "AI 提出一种观看方式，最终决定权在你。清晰度低不等于没有价值。"}
          </p>
        </div>
        <Button variant="outline" onClick={triggerSelect} disabled={!canSelect}>
          {running ? <Spinner label="筛选中" /> : busy ? <Spinner label="处理中" /> : decisions.length > 0 ? "重新筛选" : "开始推荐选片"}
        </Button>
      </div>

      {error && <p className="mb-4 text-sm text-error">{error}</p>}

      <div className="grid gap-8 pb-24 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {curationError && !curation ? (
            <LoadError message="无法加载筛选结果，请检查网络后重试。" onRetry={() => mutateCuration()} />
          ) : decisions.length === 0 ? (
            <EmptyState
              title={inspectedCount > 0 ? "还没有筛选结果" : "请先完成素材分析"}
              description={
                inspectedCount > 0
                  ? "运行审美筛选官，它会从清晰度、亮度、重复关系与构图给出保留 / 暂缓 / 移除的建议和理由——但不会替你删除任何一张。"
                  : "回到素材页运行素材管家，得到每张照片的技术分析后，再开始审美筛选。"
              }
              action={
                inspectedCount > 0 ? (
                  <Button onClick={triggerSelect} disabled={!canSelect}>开始审美筛选</Button>
                ) : undefined
              }
            />
          ) : (
            <>
              <div className="mb-5 flex gap-2">
                {TABS.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => switchTab(t.key)}
                    className={`flex-1 rounded-md border px-3 py-2 text-left transition-colors ${
                      tab === t.key
                        ? "border-gold/50 bg-gold/10 text-text"
                        : "border-ink-line bg-ink-soft text-muted hover:text-text"
                    }`}
                  >
                    <div className="flex items-center justify-between text-sm">
                      <span>{t.label}</span>
                      <span className="font-display text-base">{tabCount[t.key]}</span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted">{t.hint}</div>
                  </button>
                ))}
              </div>

              <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted">批量选择：</span>
                <Button variant="outline" className="!py-1 text-xs" disabled={busy || running || visible.length === 0} onClick={() => dispatch({ type: "select_all", scope: visibleIds })}>
                  全选当前分组
                </Button>
                <Button variant="ghost" className="!py-1 text-xs" disabled={checked.length === 0} onClick={() => dispatch({ type: "clear" })}>
                  取消全选
                </Button>
                <Button variant="outline" className="!py-1 text-xs" disabled={busy || running || visible.length === 0} onClick={() => dispatch({ type: "invert", scope: visibleIds })}>
                  反选当前分组
                </Button>
                <span className="text-muted">已选 {checked.length} 张</span>
                {undoOp && (
                  <Button variant="ghost" className="!py-1 text-xs text-gold" disabled={busy || running} onClick={() => undoOperation(undoOp.id)}>
                    撤销上次更改（{undoOp.photo_ids.length} 张）
                  </Button>
                )}
                {tabHint && <span className="text-muted">{tabHint}</span>}
              </div>

              {checked.length > 0 && (
                <div className="card mb-4 border-gold/30 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted">对已选 {checked.length} 张：</span>
                    <Button className="!py-1 text-xs" disabled={busy || running} onClick={() => requestBatch(checked, "set_decision", "keep")}>
                      设为保留
                    </Button>
                    <Button variant="outline" className="!py-1 text-xs" disabled={busy || running} onClick={() => requestBatch(checked, "set_decision", "hold")}>
                      设为暂缓
                    </Button>
                    <Button variant="outline" className="!py-1 text-xs" disabled={busy || running} onClick={() => requestBatch(checked, "set_decision", "remove")}>
                      移出本次候选
                    </Button>
                    <Button variant="outline" className="!py-1 text-xs" disabled={busy || running} onClick={() => requestBatch(checked, "set_decision", "must_keep")}>
                      ★ 必须保留
                    </Button>
                    <Button variant="ghost" className="!py-1 text-xs" disabled={busy || running} onClick={() => requestBatch(checked, "restore_ai_suggestion")}>
                      恢复 AI 建议
                    </Button>
                  </div>
                  <p className="mt-1 text-[11px] text-muted">
                    「移出本次候选」只影响这次选片，不会删除照片文件。必须保留的照片默认受保护。
                  </p>
                </div>
              )}

              {visible.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-2">
                  {tab === "hold" && (
                    <>
                      <Button variant="outline" className="!py-1 text-xs" disabled={busy || running} onClick={() => requestBatch(visibleIds, "set_decision", "keep")}>
                        全部保留（{visible.length}）
                      </Button>
                      <Button variant="ghost" className="!py-1 text-xs" disabled={busy || running} onClick={() => requestBatch(visibleIds, "set_decision", "remove")}>
                        本次全部不使用（{visible.length}）
                      </Button>
                    </>
                  )}
                  {tab === "remove" && (
                    <Button variant="outline" className="!py-1 text-xs" disabled={busy || running} onClick={() => requestBatch(visibleIds, "set_decision", "keep")}>
                      全部恢复为保留（{visible.length}）
                    </Button>
                  )}
                  {tab === "keep" && (
                    <Button variant="outline" className="!py-1 text-xs" disabled={!canConfirm} onClick={acceptAndContinue}>
                      接受当前推荐并继续
                    </Button>
                  )}
                </div>
              )}

              {visible.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted">这一栏暂时没有照片。</p>
              ) : (
                <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
                  {visible.map((d) => {
                    const photo = photoById.get(d.photo_id);
                    if (!photo) return null;
                    return (
                      <DecisionTile
                        key={d.photo_id}
                        photo={photo}
                        decision={d}
                        exhibitionId={exhibitionId}
                        checked={checked.includes(d.photo_id)}
                        onToggle={() => dispatch({ type: "toggle", id: d.photo_id })}
                        onOpen={() => setOpenPhoto(d.photo_id)}
                      />
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>

        <aside className="card h-fit p-5">
          <h2 className="mb-3 text-xs uppercase tracking-[0.2em] text-muted">智能体轨迹</h2>
          <AgentTrace exhibitionId={exhibitionId} runs={status?.runs ?? []} />
        </aside>
      </div>

      {decisions.length > 0 && (
        <div className="sticky bottom-0 z-20 -mx-2 rounded-t-lg border border-ink-line bg-ink/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-muted">
              {confirmed
                ? `已确认 ${status?.exhibition.selection_confirmed_photo_ids?.length ?? keepTotal} 张进入影展${counts.must_keep > 0 ? `（必留 ${counts.must_keep}）` : ""}。`
                : `已保存 · 保留 ${keepTotal}（必留 ${counts.must_keep}）· 暂缓 ${counts.hold} · 本次不选 ${counts.remove}`}
            </span>
            <span className="ml-auto flex flex-wrap items-center gap-2">
              <Link href={`/e/${exhibitionId}/material`} className="btn btn-ghost">返回照片</Link>
              {confirmed ? (
                <Link href={`/e/${exhibitionId}/motifs`} className="btn btn-primary">
                  去看主题 →
                </Link>
              ) : (
                <Button disabled={!canConfirm} onClick={acceptAndContinue}>
                  {busy || running ? <Spinner label="确认中" /> : "确认选片，发现主题 →"}
                </Button>
              )}
            </span>
          </div>
          {status?.exhibition.mode === "ai" && !confirmed && (
            <p className="mt-1 text-[11px] text-muted">发现主题将调用 AI 模型，可能产生费用；确认前不会调用。</p>
          )}
        </div>
      )}

      {snack && (
        <div
          role="status"
          aria-live="polite"
          className="card fixed bottom-24 left-4 right-4 z-40 border-gold/40 px-4 py-3 text-sm shadow-lg sm:left-auto sm:right-6 sm:w-96"
        >
          <span className="text-text">{snack.message}</span>
          <span className="mt-2 flex gap-2">
            {snack.undoId && (
              <Button variant="outline" className="!py-1 text-xs" disabled={busy} onClick={() => undoOperation(snack.undoId!)}>
                撤销
              </Button>
            )}
            {snack.viewKeep && (
              <Button variant="ghost" className="!py-1 text-xs" onClick={() => { switchTab("keep"); setSnack(null); }}>
                查看保留分组
              </Button>
            )}
          </span>
        </div>
      )}

      {pendingBatch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-4 backdrop-blur-sm" onClick={() => setPendingBatch(null)}>
          <div className="card w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-display text-lg text-text">选中了必须保留的照片</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              勾选范围内有 {pendingBatch.ids.filter((id) => decisionById.get(id)?.effective_decision === "must_keep").length} 张「必须保留」。
              默认会跳过它们；只有你主动选择包含，才会取消这层保护。
            </p>
            <div className="mt-5 flex flex-col gap-2">
              <Button
                disabled={busy}
                onClick={() => { const b = pendingBatch; setPendingBatch(null); runBatch(b.ids, b.action, b.decision, false); }}
              >
                跳过必须保留，更改其余照片
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => { const b = pendingBatch; setPendingBatch(null); runBatch(b.ids, b.action, b.decision, true); }}
              >
                包含必须保留的照片
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setPendingBatch(null)}>
                取消
              </Button>
            </div>
          </div>
        </div>
      )}

      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-4 backdrop-blur-sm"
          onClick={() => setConfirmOpen(false)}
        >
          <div className="card w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-display text-lg text-text">还有 {counts.hold} 张暂缓照片</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              暂缓的照片这次要不要一起纳入影展候选？这个选择只影响本次确认，之后仍可逐张修改。
            </p>
            <div className="mt-5 flex flex-col gap-2">
              <Button disabled={busy} onClick={() => confirmSelection("exclude")}>
                本次先不使用暂缓照片
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => confirmSelection("include")}>
                把暂缓照片也纳入候选
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setConfirmOpen(false)}>
                返回看看
              </Button>
            </div>
          </div>
        </div>
      )}

      {openDecision && (
        <DecisionDetail
          decision={openDecision}
          photo={photoById.get(openDecision.photo_id)}
          inspection={inspections.get(openDecision.photo_id)}
          exhibitionId={exhibitionId}
          related={openDecision.related_photo_ids
            .map((id) => photoById.get(id))
            .filter((p): p is PhotoAsset => Boolean(p))}
          busy={busy}
          onDecide={(dec) => decide(openDecision.photo_id, dec)}
          onRestore={() => runBatch([openDecision.photo_id], "restore_ai_suggestion", undefined, openDecision.effective_decision === "must_keep")}
          onOpenRelated={(id) => setOpenPhoto(id)}
          onClose={() => setOpenPhoto(null)}
        />
      )}
    </div>
  );
}

function DecisionTile({
  photo,
  decision,
  exhibitionId,
  checked,
  onToggle,
  onOpen,
}: {
  photo: PhotoAsset;
  decision: CurationDecisionDTO;
  exhibitionId: string;
  checked: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const ratio = photo.width && photo.height ? photo.width / photo.height : 1;
  const e = decision.effective_decision;
  return (
    <li>
      <div className="group relative">
        <button type="button" onClick={onOpen} className="block w-full text-left">
          <div
            className="relative overflow-hidden rounded-md border border-ink-line bg-ink-soft transition-colors group-hover:border-gold/40"
            style={{ aspectRatio: String(ratio) }}
          >
            {photo.thumbnail_path ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={apiUrl(`/api/files/${exhibitionId}/${photo.id}?variant=thumb`)}
                alt={photo.original_name}
                loading="lazy"
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-xs text-error">损坏</div>
            )}
            <span className="absolute right-1.5 top-1.5 flex flex-col items-end gap-1">
              {e === "must_keep" && (
                <span className="rounded-full bg-gold/90 px-2 py-0.5 text-[10px] font-medium text-ink">
                  ★ 必留
                </span>
              )}
              {decision.user_override && e !== "must_keep" && (
                <span className="rounded-full bg-ink/80 px-2 py-0.5 text-[10px] text-gold">
                  已覆盖
                </span>
              )}
            </span>
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-1">
            <span className="truncate text-xs text-text" title={photo.original_name}>
              {photo.original_name}
            </span>
            <Badge tone={e === "keep" || e === "must_keep" ? "ok" : e === "hold" ? "warn" : "error"}>
              {DECISION_LABEL[e]}
            </Badge>
          </div>
        </button>
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          aria-label={`选择 ${photo.original_name}`}
          className="absolute left-1.5 top-1.5 z-10 h-4 w-4 cursor-pointer accent-gold"
        />
      </div>
    </li>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-ink-line bg-ink px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-0.5 text-sm text-text">{value}</div>
    </div>
  );
}

function DecisionDetail({
  decision,
  photo,
  inspection,
  exhibitionId,
  related,
  busy,
  onDecide,
  onRestore,
  onOpenRelated,
  onClose,
}: {
  decision: CurationDecisionDTO;
  photo?: PhotoAsset;
  inspection?: PhotoInspectionT;
  exhibitionId: string;
  related: PhotoAsset[];
  busy: boolean;
  onDecide: (d: UserDecisionT) => void;
  onRestore: () => void;
  onOpenRelated: (id: string) => void;
  onClose: () => void;
}) {
  const e = decision.effective_decision;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const buttons: { d: UserDecisionT; variant: "primary" | "outline" | "ghost" }[] = [
    { d: "keep", variant: "outline" },
    { d: "hold", variant: "outline" },
    { d: "remove", variant: "outline" },
    { d: "must_keep", variant: "primary" },
  ];
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-4 backdrop-blur-sm sm:p-6"
      onClick={onClose}
    >
      <div
        className="card max-h-[88vh] w-full max-w-3xl overflow-auto p-6"
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h3 className="font-display text-lg text-text">{photo?.original_name ?? "照片"}</h3>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Badge tone={e === "keep" || e === "must_keep" ? "ok" : e === "hold" ? "warn" : "error"}>
                {DECISION_LABEL[e]}
              </Badge>
              {decision.user_override ? (
                <span className="text-xs text-gold">你的决定（AI 建议：{DECISION_LABEL[decision.ai_decision]}）</span>
              ) : (
                <span className="text-xs text-muted">AI 建议 · 仅供参考</span>
              )}
            </div>
          </div>
          <button type="button" className="text-muted hover:text-text" onClick={onClose}>✕</button>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div className="overflow-hidden rounded-md border border-ink-line bg-ink">
            {photo?.thumbnail_path ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={apiUrl(`/api/files/${exhibitionId}/${decision.photo_id}?variant=thumb`)}
                alt={photo.original_name}
                className="h-full w-full object-contain"
              />
            ) : (
              <div className="flex h-48 items-center justify-center text-xs text-error">损坏</div>
            )}
          </div>

          <div>
            <div className="mb-2 text-xs uppercase tracking-wider text-muted">可观察证据</div>
            <div className="grid grid-cols-2 gap-2">
              <Metric label="清晰度" value={inspection ? pct(inspection.sharpness_score) : "—"} />
              <Metric label="亮度" value={inspection ? pct(inspection.brightness_score) : "—"} />
              <Metric label="高光溢出" value={inspection ? pct(inspection.highlight_clip_ratio) : "—"} />
              <Metric label="重复关系" value={inspection?.duplicate_group_id ? "有近重复" : "独特"} />
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Metric label="审美评分" value={pct(decision.score)} />
              <Metric label="置信度" value={pct(decision.confidence)} />
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted">
              审美评分只是参考之一，不是唯一结论。技术质量低不等于没有价值。
            </p>
          </div>
        </div>

        <div className="mt-5">
          <div className="mb-2 text-xs uppercase tracking-wider text-muted">理由</div>
          <ul className="space-y-1.5">
            {decision.reasons.map((r, i) => (
              <li key={i} className="flex gap-2 text-sm leading-relaxed text-text/90">
                <span className="text-gold">·</span>
                <span>{r}</span>
              </li>
            ))}
            {decision.override_reason && (
              <li className="flex gap-2 text-sm leading-relaxed text-gold">
                <span>★</span>
                <span>你的理由：{decision.override_reason}</span>
              </li>
            )}
          </ul>
        </div>

        {related.length > 0 && (
          <div className="mt-5">
            <div className="mb-2 text-xs uppercase tracking-wider text-muted">关联照片</div>
            <div className="flex flex-wrap gap-2">
              {related.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onOpenRelated(p.id)}
                  className="h-16 w-16 overflow-hidden rounded-md border border-ink-line hover:border-gold/50"
                  title={p.original_name}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={apiUrl(`/api/files/${exhibitionId}/${p.id}?variant=thumb`)}
                    alt={p.original_name}
                    className="h-full w-full object-cover"
                  />
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-6 flex flex-wrap gap-2 border-t border-ink-line pt-4">
          {buttons.map((b) => (
            <Button
              key={b.d}
              variant={e === b.d ? "primary" : b.variant}
              disabled={busy}
              onClick={() => onDecide(b.d)}
            >
              {b.d === "must_keep" ? "★ 必须保留" : DECISION_LABEL[b.d]}
            </Button>
          ))}
          {decision.user_override && (
            <Button variant="ghost" disabled={busy} onClick={onRestore}>
              恢复 AI 建议
            </Button>
          )}
        </div>
        <p className="mt-2 text-[11px] text-muted">
          「必须保留」只能由你设定，AI 永远不会删除或覆盖它。
        </p>
      </div>
    </div>
  );
}
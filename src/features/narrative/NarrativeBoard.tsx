"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useStatus, usePhotos, useNarrative, useVersions } from "@/lib/hooks";
import { useLandingFocus } from "@/lib/useLandingFocus";
import { AgentTrace, getSourceLabel } from "@/components/AgentTrace";
import { LoadError } from "@/components/LoadError";
import { Badge, Button, EmptyState, Spinner } from "@/components/ui";
import { FieldEditor } from "./FieldEditor";
import { ChapterTree } from "./ChapterTree";
import { useSaveBarrier } from "./useSaveBarrier";
import type { NarrativeEditT, ToneT } from "@/lib/agents/schemas";

const JSON_HEADERS = { "content-type": "application/json" };

const TONES: { value: ToneT; label: string }[] = [
  { value: "documentary", label: "纪实" },
  { value: "restrained", label: "克制" },
  { value: "poetic", label: "诗意" },
  { value: "direct", label: "直接" },
];

export function NarrativeBoard({ exhibitionId }: { exhibitionId: string }) {
  const router = useRouter();
  const { register: registerSaver, flush: flushSaves } = useSaveBarrier();
  const [headingRef, landingMessage] = useLandingFocus(exhibitionId, "调整内容");
  const { data: status, error: statusError, mutate: mutateStatus } = useStatus(exhibitionId);
  const { data: photoData } = usePhotos(exhibitionId);
  const running = status?.is_running ?? false;
  const { data: narrativeData, mutate: mutateNarrative } = useNarrative(exhibitionId, running);
  const { data: versionData, mutate: mutateVersions } = useVersions(exhibitionId);

  const [working, setBusy] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const busy = working || advancing;
  const nextInFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const confirmedNarrative = useRef(narrativeData?.narrative ?? null);
  const patchQueue = useRef<Promise<boolean>>(Promise.resolve(true));
  // 成功响应立即更新 ref，下一字段不必等 SWR/render；较旧重取不能倒退修订。
  useEffect(() => {
    const n = narrativeData?.narrative;
    const current = confirmedNarrative.current;
    if (n && (!current || n.edit_revision > current.edit_revision ||
      (n.edit_revision === current.edit_revision && n.current_version >= current.current_version))) confirmedNarrative.current = n;
  }, [narrativeData]);
  const [scope, setScope] = useState<"unlocked" | "all">("unlocked");

  const photos = photoData?.photos ?? [];
  const photoById = new Map(photos.map((p) => [p.id, p]));
  const narrative = narrativeData?.narrative ?? null;
  const edits = narrativeData?.edits ?? [];
  const versions = versionData?.versions ?? [];
  const inspectedCount = status?.photos.inspected ?? 0;
  const selectedId = status?.exhibition.selected_motif_id ?? null;
  const currentTone = (narrative?.tone ?? status?.exhibition.tone ?? "restrained") as ToneT;
  const lockedOf = (path: string) => edits.find((e) => e.target_path === path)?.locked ?? false;
  const canGenerate = photos.length > 0 && inspectedCount > 0 && !!selectedId && !running && !busy;

  const run = useCallback(
    async (url: string, init: RequestInit, failMsg: string): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(url, init);
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error?.message ?? failMsg);
        await Promise.all([mutateNarrative(), mutateStatus(), mutateVersions()]);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : failMsg);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [mutateNarrative, mutateStatus, mutateVersions],
  );

  const generate = useCallback(
    () => run(
      `/api/exhibitions/${exhibitionId}/runs/narrative`,
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ request_id: crypto.randomUUID() }) },
      "启动叙事生成失败",
    ),
    [exhibitionId, run],
  );
  const regenerate = useCallback(
    () =>
      run(
        `/api/exhibitions/${exhibitionId}/narrative/regenerate`,
        { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ scope, request_id: crypto.randomUUID() }) },
        "重新生成失败",
      ),
    [exhibitionId, run, scope],
  );
  const changeTone = useCallback(
    (tone: ToneT) =>
      run(
        `/api/exhibitions/${exhibitionId}/runs/narrative`,
        { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ tone, request_id: crypto.randomUUID() }) },
        "切换语气失败",
      ),
    [exhibitionId, run],
  );
  const patch = useCallback((edits: NarrativeEditT[]): Promise<boolean> => {
    const save = async () => {
      setBusy(true);
      setError(null);
      try {
        const current = confirmedNarrative.current;
        if (!current) throw new Error("请先加载叙事，再保存编辑。");
        const res = await fetch(`/api/exhibitions/${exhibitionId}/narrative`, {
          method: "PATCH", headers: JSON_HEADERS,
          body: JSON.stringify({ edits, expected_version: current.current_version, expected_edit_revision: current.edit_revision }),
        });
        const data = await res.json();
        if (!res.ok) {
          if (res.status === 409 && data?.error?.code === "version_conflict") {
            throw new Error("内容已在其他操作中更新，你的草稿已保留，请查看最新内容后再保存。");
          }
          throw new Error(data?.error?.message ?? "保存编辑失败");
        }
        // 确认保存只采用本次服务端响应；不经 status、不重取覆盖草稿、不静默重试。
        confirmedNarrative.current = data.narrative;
        await mutateNarrative(data, { revalidate: false });
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "保存编辑失败");
        return false;
      } finally { setBusy(false); }
    };
    const pending = patchQueue.current.then(save);
    patchQueue.current = pending;
    return pending;
  }, [exhibitionId, mutateNarrative]);
  const onField = useCallback(
    (targetPath: string, value: string, locked: boolean) =>
      patch([{ target_path: targetPath, value, locked }]),
    [patch],
  );
  const restore = useCallback(
    (version: number) =>
      run(`/api/exhibitions/${exhibitionId}/versions/${version}`, { method: "POST" }, "回滚失败"),
    [exhibitionId, run],
  );
  // 下一步 = 保存屏障：先等待所有编辑中的草稿落盘，失败则不导航、草稿留在原地。
  const goNext = useCallback(async () => {
    if (nextInFlight.current) return;
    nextInFlight.current = true;
    setAdvancing(true);
    setError(null);
    try {
      const ok = await flushSaves();
      if (!ok) {
        setError((previous) => previous ?? "还有未保存的修改，请重试后再继续。");
        return;
      }
      router.push(`/e/${exhibitionId}/layout`);
    } catch {
      setError((previous) => previous ?? "还有未保存的修改，请重试后再继续。");
    } finally {
      nextInFlight.current = false;
      setAdvancing(false);
    }
  }, [flushSaves, router, exhibitionId]);

  if (statusError && !status) {
    return <LoadError message="无法加载影展状态，请检查网络后重试。" onRetry={() => mutateStatus()} />;
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          {landingMessage && <p role="status" aria-live="polite" className="sr-only">{landingMessage}</p>}
          <h1 ref={headingRef} tabIndex={-1} className="font-display text-2xl text-text outline-none">调整内容</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            以你选定的主题为主线，把保留照片组织成章节。文案只描述可见事实，不编造人物经历。每个字段都可编辑、锁定；锁定后重新生成不会覆盖。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {narrative ? (
            <>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as "unlocked" | "all")}
                className="rounded-md border border-ink-line bg-ink px-2 py-1.5 text-sm text-text outline-none"
                title="重新生成时如何处理你的编辑"
              >
                <option value="unlocked">保留锁定编辑</option>
                <option value="all">丢弃全部编辑</option>
              </select>
              <Button variant="outline" onClick={() => regenerate()} disabled={!canGenerate}>
                {running ? <Spinner label="生成中" /> : busy ? <Spinner label="启动中" /> : "重新生成 ↻"}
              </Button>
              <Button onClick={() => void goNext()} disabled={busy || running}>
                确认内容，查看版式 →
              </Button>
            </>
          ) : (
            <Button onClick={generate} disabled={!canGenerate}>
              {running ? <Spinner label="生成中" /> : busy ? <Spinner label="启动中" /> : "开始叙事生成"}
            </Button>
          )}
        </div>
      </div>

      {error && <p className="mb-4 text-sm text-error">{error}</p>}

      {!selectedId && (
        <EmptyState
          title="请先选择主题主线"
          description="叙事需要一条主线。回到主题页选一个候选母题作为主线，再回来生成叙事。"
          action={<Link href={`/e/${exhibitionId}/motifs`} className="btn btn-primary">去选主题 →</Link>}
        />
      )}

      {selectedId && !narrative && (
        <EmptyState
          title="尚未生成叙事"
          description={
            inspectedCount > 0
              ? "叙事编剧会把保留照片组织成 2–4 个章节，生成标题、策展语与克制的章节文字，并为开场/转折/结尾照片给出放置理由。"
              : "请先完成素材分析与筛选，再开始叙事生成。"
          }
          action={inspectedCount > 0 ? <Button onClick={generate} disabled={!canGenerate}>开始叙事生成</Button> : undefined}
        />
      )}

      {narrative && (
        <>
          <div className="card mb-6 p-6">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span className="text-xs uppercase tracking-[0.2em] text-muted">语气</span>
              {TONES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  disabled={!canGenerate}
                  onClick={() => changeTone(t.value)}
                  className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                    currentTone === t.value ? "border-gold/50 bg-gold/10 text-gold" : "border-ink-line text-muted hover:text-text"
                  }`}
                >
                  {t.label}
                </button>
              ))}
              <Badge tone="muted">{getSourceLabel(narrative.source)}</Badge>
            </div>
            <FieldEditor
              value={narrative.title}
              locked={lockedOf("narrative.title")}
              maxLength={60}
              disabled={busy || running}
              register={registerSaver}
              onSave={(v, l) => onField("narrative.title", v, l)}
              className="font-display text-3xl text-text"
            />
            <FieldEditor
              value={narrative.subtitle}
              locked={lockedOf("narrative.subtitle")}
              maxLength={80}
              disabled={busy || running}
              register={registerSaver}
              onSave={(v, l) => onField("narrative.subtitle", v, l)}
              className="mt-2 text-sm text-muted"
            />
            <div className="mt-4 border-t border-ink-line pt-4">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">策展语</div>
              <FieldEditor
                value={narrative.curatorial_statement}
                locked={lockedOf("narrative.curatorial_statement")}
                maxLength={100}
                multiline
                disabled={busy || running}
                register={registerSaver}
                onSave={(v, l) => onField("narrative.curatorial_statement", v, l)}
                className="text-sm leading-relaxed text-text/90"
              />
            </div>
          </div>

          <div className="grid gap-8 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-xs uppercase tracking-[0.2em] text-muted">章节 · 拖照片跨章移动</h2>
                <span className="text-[11px] text-muted">{narrative.chapters.length} 章</span>
              </div>
              <ChapterTree
                chapters={narrative.chapters}
                photoById={photoById}
                exhibitionId={exhibitionId}
                edits={edits}
                disabled={busy || running}
                onPersist={patch}
                onField={onField}
                registerSaver={registerSaver}
              />
            </div>

            <aside className="flex flex-col gap-6">
              <div className="card h-fit p-5">
                <h2 className="mb-3 text-xs uppercase tracking-[0.2em] text-muted">版本 · 回滚</h2>
                {versions.length === 0 ? (
                  <p className="text-xs text-muted">生成叙事后会自动保存版本。</p>
                ) : (
                  <ul className="space-y-2">
                    {versions.map((v) => (
                      <li key={v.id} className="flex items-center justify-between gap-2 text-sm">
                        <span className="text-text/90">
                          v{v.version}
                          {v.label && <span className="ml-1 text-[11px] text-muted">{v.label}</span>}
                        </span>
                        <Button variant="ghost" disabled={busy || running} onClick={() => restore(v.version)}>
                          回滚
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="card h-fit p-5">
                <h2 className="mb-3 text-xs uppercase tracking-[0.2em] text-muted">智能体轨迹</h2>
                <AgentTrace exhibitionId={exhibitionId} runs={status?.runs ?? []} />
              </div>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
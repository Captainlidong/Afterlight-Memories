"use client";

import { useEffect, useRef, useState } from "react";
import type { PendingSaver } from "./useSaveBarrier";

/**
 * 单字段编辑 + 锁定（§8.8 / 提示词8 / v3 R02）。
 * onSave 返回是否成功：只有服务端确认保存才退出编辑；失败保留草稿与编辑态可原地重试。
 * 锁定切换同样等待结果并显示失败提示，不做「假成功」。
 */
export function FieldEditor({
  value,
  locked,
  maxLength,
  multiline = false,
  disabled = false,
  onSave,
  register,
  className = "",
}: {
  value: string;
  locked: boolean;
  maxLength: number;
  multiline?: boolean;
  disabled?: boolean;
  onSave: (value: string, locked: boolean) => Promise<boolean>;
  register?: (save: PendingSaver) => () => void;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [lockBusy, setLockBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef(value);
  const saveRef = useRef<PendingSaver>(async () => true);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const editingRef = useRef(false);
  const editingBase = useRef({ value, locked });
  const cancel = () => {
    if (inFlight.current) return;
    editingRef.current = false;
    setEditing(false);
  };

  const start = () => {
    if (inFlight.current || disabled) return;
    editingRef.current = true;
    editingBase.current = { value, locked };
    draftRef.current = value;
    setDraft(value);
    setError(null);
    setEditing(true);
  };

  const save = (): Promise<boolean> => {
    // state 更新要等 render；ref 在同一事件轮次就占用，屏障与重复点击共用真正的 Promise。
    if (inFlight.current) return inFlight.current;
    if (!editingRef.current) return Promise.resolve(true);
    const t = draftRef.current;
    // 后台刷新不能让旧草稿悄悄借用新修订：保留草稿，要求用户先查看更新。
    if ((value !== editingBase.current.value && t !== value) || locked !== editingBase.current.locked) {
      setError("该字段已在其他操作中更新，你的草稿已保留。请查看最新内容后再决定如何保存。");
      return Promise.resolve(false);
    }
    if (t === value) {
      editingRef.current = false;
      setEditing(false);
      setError(null);
      return Promise.resolve(true);
    }
    setSaving(true);
    setError(null);
    inFlight.current = Promise.resolve().then(async () => {
      try {
        const ok = await onSave(t, locked);
        if (ok) {
          editingRef.current = false;
          setDraft(t);
          setEditing(false);
        } else setError("保存失败，草稿已保留，请重试。");
        return ok;
      } catch {
        setError("保存失败，草稿已保留，请重试。");
        return false;
      } finally {
        inFlight.current = null;
        setSaving(false);
      }
    });
    return inFlight.current;
  };

  // 供「下一步」等离页动作调用：始终使用最新草稿
  useEffect(() => {
    saveRef.current = () => inFlight.current ?? (editing ? save() : Promise.resolve(true));
  });

  useEffect(() => {
    if (!register) return;
    return register(() => saveRef.current());
  }, [register]);

  const toggleLock = (): Promise<boolean> => {
    if (inFlight.current) return inFlight.current;
    setLockBusy(true);
    setError(null);
    inFlight.current = Promise.resolve().then(async () => {
      try {
        const ok = await onSave(value, !locked);
        if (!ok) setError("锁定状态保存失败，请重试。");
        return ok;
      } catch {
        setError("锁定状态保存失败，请重试。");
        return false;
      } finally {
        inFlight.current = null;
        setLockBusy(false);
      }
    });
    return inFlight.current;
  };

  if (editing) {
    return (
      <div className={`flex flex-col gap-2 ${className}`}>
        {multiline ? (
          <textarea
            autoFocus
            value={draft}
            readOnly={saving || disabled}
            aria-busy={saving}
            maxLength={maxLength}
            rows={3}
            onChange={(e) => {
              if (inFlight.current || disabled) return;
              draftRef.current = e.target.value;
              setDraft(e.target.value);
            }}
            onKeyDown={(e) => { if (e.key === "Escape") cancel(); }}
            className="w-full rounded-md border border-ink-line bg-ink px-2 py-1 text-sm leading-relaxed text-text outline-none focus:border-gold/50"
          />
        ) : (
          <input
            autoFocus
            value={draft}
            readOnly={saving || disabled}
            aria-busy={saving}
            maxLength={maxLength}
            onChange={(e) => {
              if (inFlight.current || disabled) return;
              draftRef.current = e.target.value;
              setDraft(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
              if (e.key === "Escape") cancel();
            }}
            className="w-full rounded-md border border-ink-line bg-ink px-2 py-1 text-sm text-text outline-none focus:border-gold/50"
          />
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-primary px-2 py-0.5 text-xs" onClick={() => void save()} disabled={saving}>
            {saving ? "正在保存…" : "保存"}
          </button>
          <button type="button" className="btn btn-ghost px-2 py-0.5 text-xs" onClick={cancel} disabled={saving}>
            取消
          </button>
          <span className="text-[10px] text-muted">{[...draft].length}/{maxLength}</span>
          {error && <span role="alert" className="text-[11px] text-error">{error}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <div className="group flex items-start gap-2">
        <div className="flex-1">{value}</div>
        {!disabled && (
          <div className="flex shrink-0 items-center gap-1 opacity-60 transition-opacity group-hover:opacity-100">
            <button type="button" title="编辑" className="text-muted hover:text-gold" onClick={start}>✎</button>
            <button
              type="button"
              title={locked ? "已锁定：重新生成时保留（点击解锁）" : "锁定：重新生成时保留此字段"}
              className={locked ? "text-gold" : "text-muted hover:text-gold"}
              disabled={lockBusy}
              onClick={() => void toggleLock()}
            >
              {lockBusy ? "…" : locked ? "🔒" : "🔓"}
            </button>
          </div>
        )}
      </div>
      {error && <span role="alert" className="text-[11px] text-error">{error}</span>}
    </div>
  );
}

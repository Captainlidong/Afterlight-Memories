"use client";

import { useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDroppable,
  closestCorners,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { FieldEditor } from "./FieldEditor";
import type { PendingSaver } from "./useSaveBarrier";
import type { ChapterT, NarrativeEditT } from "@/lib/agents/schemas";
import type { PhotoAsset, UserEditDTO } from "@/types";

/**
 * 章节树（§8.8）：dnd-kit 跨章节拖照片 + 每章标题/描述编辑锁定。
 * 拖拽期间用本地态乐观重排；落定后把归属/顺序写成 user_edits 覆盖层（不重跑 AI），
 * 由 merge 在下次重生成时回放。布局实时读叙事，故重排只标 stale_from=layout。
 */
export function ChapterTree({
  chapters,
  photoById,
  exhibitionId,
  edits,
  disabled,
  onPersist,
  onField,
  registerSaver,
}: {
  chapters: ChapterT[];
  photoById: Map<string, PhotoAsset>;
  exhibitionId: string;
  edits: UserEditDTO[];
  disabled: boolean;
  onPersist: (edits: NarrativeEditT[]) => Promise<boolean>;
  onField: (targetPath: string, value: string, locked: boolean) => Promise<boolean>;
  registerSaver?: (save: PendingSaver) => () => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const persistSequence = useRef(0);
  // 乐观重排：草稿仅在基于当前 props 时生效；props 一更新就自动回到权威数据（无需 effect 同步）。
  const [draft, setDraft] = useState<{ base: ChapterT[]; chapters: ChapterT[] } | null>(null);
  const shown = draft && draft.base === chapters ? draft.chapters : chapters;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const findContainer = (id: string): string | null => {
    if (shown.some((c) => c.id === id)) return id;
    return shown.find((c) => c.photo_ids.includes(id))?.id ?? null;
  };
  const lockedOf = (path: string) => edits.find((e) => e.target_path === path)?.locked ?? false;

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));

  const onDragOver = (e: DragOverEvent) => {
    const active = String(e.active.id);
    const over = e.over ? String(e.over.id) : null;
    if (!over) return;
    const from = findContainer(active);
    const to = findContainer(over);
    if (!from || !to || from === to) return;
    const target = shown.find((c) => c.id === to);
    if (!target) return;
    const overIndex = target.photo_ids.includes(over) ? target.photo_ids.indexOf(over) : target.photo_ids.length;
    setDraft({
      base: chapters,
      chapters: shown.map((c) => {
        if (c.id === from) return { ...c, photo_ids: c.photo_ids.filter((id) => id !== active) };
        if (c.id === to) {
          const ids = [...c.photo_ids];
          ids.splice(overIndex, 0, active);
          return { ...c, photo_ids: ids };
        }
        return c;
      }),
    });
  };

  const onDragEnd = async (e: DragEndEvent) => {
    const active = String(e.active.id);
    const over = e.over ? String(e.over.id) : null;
    setActiveId(null);
    if (!over) { setDraft(null); return; }
    const from = findContainer(active);
    const to = findContainer(over);
    if (!from || !to) { setDraft(null); return; }

    let next = shown;
    if (from === to) {
      const c = shown.find((x) => x.id === from)!;
      const oldIndex = c.photo_ids.indexOf(active);
      const newIndex = c.photo_ids.includes(over) ? c.photo_ids.indexOf(over) : c.photo_ids.length - 1;
      if (oldIndex !== newIndex && oldIndex >= 0 && newIndex >= 0) {
        next = shown.map((x) => (x.id === from ? { ...x, photo_ids: arrayMove(c.photo_ids, oldIndex, newIndex) } : x));
      }
    }
    setDraft(next === chapters ? null : { base: chapters, chapters: next });

    const originalChapter = chapters.find((c) => c.photo_ids.includes(active));
    const finalChapter = next.find((c) => c.photo_ids.includes(active));
    const payload: NarrativeEditT[] = [];
    if (originalChapter && finalChapter && originalChapter.id !== finalChapter.id) {
      payload.push({ target_path: `photo:${active}.membership`, value: finalChapter.id });
    }
    const affected = new Set([originalChapter?.id, finalChapter?.id].filter(Boolean) as string[]);
    for (const cid of affected) {
      const c = next.find((x) => x.id === cid);
      if (c) payload.push({ target_path: `chapter:${cid}.photo_order`, value: c.photo_ids });
    }
    if (payload.length > 0) {
      const sequence = ++persistSequence.current;
      try {
        if (!(await onPersist(payload)) && sequence === persistSequence.current) setDraft(null);
      } catch {
        // 权威数据未保存时撤销本地预览；失败信息由父级保存入口展示。
        if (sequence === persistSequence.current) setDraft(null);
      }
    }
  };

  const activePhoto = activeId ? photoById.get(activeId) : undefined;

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd}>
      <div className="flex flex-col gap-5">
        {shown.map((c) => (
          <ChapterCard
            key={c.id}
            chapter={c}
            photoById={photoById}
            exhibitionId={exhibitionId}
            disabled={disabled}
            titleLocked={lockedOf(`chapter:${c.id}.title`)}
            descLocked={lockedOf(`chapter:${c.id}.description`)}
            onField={onField}
            registerSaver={registerSaver}
          />
        ))}
      </div>
      <DragOverlay>
        {activePhoto ? (
          <div className="h-20 w-20 overflow-hidden rounded-md border border-gold/60 shadow-lg">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/files/${exhibitionId}/${activePhoto.id}?variant=thumb`} alt="" className="h-full w-full object-cover" />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function ChapterCard({
  chapter,
  photoById,
  exhibitionId,
  disabled,
  titleLocked,
  descLocked,
  onField,
  registerSaver,
}: {
  chapter: ChapterT;
  photoById: Map<string, PhotoAsset>;
  exhibitionId: string;
  disabled: boolean;
  titleLocked: boolean;
  descLocked: boolean;
  onField: (targetPath: string, value: string, locked: boolean) => Promise<boolean>;
  registerSaver?: (save: PendingSaver) => () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: chapter.id, disabled });
  return (
    <section className={`card p-5 ${isOver ? "border-gold/50" : ""}`}>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-muted">{chapter.id}</span>
        {chapter.locked && <span className="text-[11px] text-gold">🔒 章节锁定</span>}
      </div>
      <FieldEditor
        value={chapter.title}
        locked={titleLocked}
        maxLength={60}
        disabled={disabled}
        register={registerSaver}
        onSave={(v, l) => onField(`chapter:${chapter.id}.title`, v, l)}
        className="font-display text-lg text-text"
      />
      <FieldEditor
        value={chapter.description}
        locked={descLocked}
        maxLength={100}
        multiline
        disabled={disabled}
        register={registerSaver}
        onSave={(v, l) => onField(`chapter:${chapter.id}.description`, v, l)}
        className="mt-2 text-sm leading-relaxed text-text/85"
      />
      <div ref={setNodeRef} className="mt-4 min-h-[5rem] rounded-md border border-dashed border-ink-line p-2">
        <SortableContext items={chapter.photo_ids} strategy={rectSortingStrategy} disabled={disabled}>
          <div className="flex flex-wrap gap-2">
            {chapter.photo_ids.map((pid) => (
              <SortablePhoto key={pid} photoId={pid} photo={photoById.get(pid)} exhibitionId={exhibitionId} disabled={disabled} />
            ))}
          </div>
        </SortableContext>
        {chapter.photo_ids.length === 0 && <p className="px-1 py-3 text-xs text-muted">拖照片到此章节</p>}
      </div>
      {chapter.placement_reasons.length > 0 && (
        <ul className="mt-3 space-y-1">
          {chapter.placement_reasons.map((r) => (
            <li key={r.photo_id} className="text-xs leading-relaxed text-muted">
              <span className="text-gold">·</span> {r.reason}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SortablePhoto({
  photoId,
  photo,
  exhibitionId,
  disabled,
}: {
  photoId: string;
  photo: PhotoAsset | undefined;
  exhibitionId: string;
  disabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: photoId, disabled });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`h-20 w-20 cursor-grab overflow-hidden rounded-md border border-ink-line active:cursor-grabbing ${isDragging ? "opacity-30" : "hover:border-gold/50"}`}
      title={photo?.original_name ?? photoId}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/api/files/${exhibitionId}/${photoId}?variant=thumb`} alt={photo?.original_name ?? ""} loading="lazy" className="h-full w-full object-cover" />
    </div>
  );
}

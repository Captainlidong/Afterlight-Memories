/* eslint-disable @typescript-eslint/no-explicit-any -- This DOM-free React hook harness stores heterogeneous hook slots and inspects drag-handler element props. */
import { describe, expect, it, vi } from "vitest";
import { ChapterTree } from "@/features/narrative/ChapterTree";
import type { ChapterT } from "@/lib/agents/schemas";

const hooks = vi.hoisted(() => ({ current: null as any }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: any) => hooks.current.state(initial),
  useRef: (initial: any) => hooks.current.ref(initial),
}));
vi.mock("@dnd-kit/core", () => ({
  DndContext: "dnd-context", DragOverlay: "drag-overlay",
  PointerSensor: {}, KeyboardSensor: {}, closestCorners: {},
  useSensor: () => ({}), useSensors: () => [], useDroppable: () => ({}),
}));
vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: "sortable-context", rectSortingStrategy: {}, sortableKeyboardCoordinates: {},
  useSortable: () => ({}),
  arrayMove: (items: string[], from: number, to: number) => { const next = [...items]; next.splice(to, 0, next.splice(from, 1)[0]); return next; },
}));
vi.mock("@dnd-kit/utilities", () => ({ CSS: { Transform: { toString: () => "" } } }));

function harness<T>(component: () => T) {
  const slots: any[] = []; let cursor = 0;
  const api = {
    state(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (value: any) => { slots[i] = value; }]; },
    ref(initial: any) { return slots[cursor++] ??= { current: initial }; },
    render() { cursor = 0; hooks.current = api; return component(); },
  };
  return api;
}
function elements(tree: any): any[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree?.props) return [];
  return [tree, ...elements(tree.props.children)];
}
const chapters = [
  { id: "c1", title: "一", description: "", photo_ids: ["p1", "p2"], placement_reasons: [], locked: false },
  { id: "c2", title: "二", description: "", photo_ids: ["p3"], placement_reasons: [], locked: false },
] as ChapterT[];

describe("章节排序保存反馈", () => {
  it.each(["rejected", "network"])("%s 失败后恢复权威顺序，不把预览伪装成保存成功", async (kind) => {
    const request = Promise.withResolvers<boolean>();
    const onPersist = vi.fn(() => request.promise);
    const h = harness(() => ChapterTree({ chapters, photoById: new Map(), exhibitionId: "exh", edits: [], disabled: false, onPersist, onField: vi.fn() }));
    const tree = h.render();
    const save = tree.props.onDragEnd({ active: { id: "p1" }, over: { id: "p2" } });
    const shown = () => elements(h.render()).filter((e) => e.props.chapter).map((e) => e.props.chapter.photo_ids);
    expect(shown()).toEqual([["p2", "p1"], ["p3"]]);
    if (kind === "network") request.reject(new Error("offline"));
    else request.resolve(false);
    await save;
    expect(shown()).toEqual([["p1", "p2"], ["p3"]]);
    expect(onPersist).toHaveBeenCalledOnce();
  });
});

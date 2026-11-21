/* eslint-disable @typescript-eslint/no-explicit-any -- This DOM-free React hook harness stores heterogeneous hook slots and inspects heterogeneous element props. */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { FieldEditor } from "@/features/narrative/FieldEditor";
import { NarrativeBoard } from "@/features/narrative/NarrativeBoard";
import { useSaveBarrier } from "@/features/narrative/useSaveBarrier";

// Stateful hook/handler harness: no browser, service, new DOM dependency, or filesystem data.
const hooks = vi.hoisted(() => ({ current: null as any }));
const state = vi.hoisted(() => ({ narrative: null as any, mutate: vi.fn(), push: vi.fn(), fetch: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: any) => hooks.current.state(initial),
  useRef: (initial: any) => hooks.current.ref(initial),
  useCallback: (callback: any) => callback,
  useEffect: (effect: any, deps?: any[]) => hooks.current.effect(effect, deps),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock("@/lib/useLandingFocus", () => ({ useLandingFocus: () => [null, null] }));
vi.mock("@/lib/hooks", () => ({
  useStatus: () => ({ data: { exhibition: { selected_motif_id: "m", current_version: 999 }, photos: { inspected: 2 }, runs: [] }, mutate: vi.fn() }),
  usePhotos: () => ({ data: { photos: [{ id: "p1" }] } }),
  useNarrative: () => ({ data: state.narrative, mutate: state.mutate }),
  useVersions: () => ({ data: { versions: [] }, mutate: vi.fn() }),
}));
vi.mock("@/features/narrative/ChapterTree", () => ({ ChapterTree: () => null }));
vi.mock("@/components/AgentTrace", () => ({ AgentTrace: () => null, getSourceLabel: () => "source" }));

function harness<T>(component: () => T) {
  const slots: any[] = [];
  let cursor = 0;
  let effects: (() => void)[] = [];
  const api = {
    state(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], (v: any) => { slots[i] = typeof v === "function" ? v(slots[i]) : v; }]; },
    ref(initial: any) { const i = cursor++; return slots[i] ??= { current: initial }; },
    effect(effect: any, deps?: any[]) {
      const i = cursor++; const prev = slots[i];
      if (!prev || !deps || deps.some((d, j) => d !== prev.deps?.[j])) effects.push(() => { prev?.cleanup?.(); slots[i] = { deps, cleanup: effect() }; });
    },
    render() { cursor = 0; effects = []; hooks.current = api; const tree = component(); for (const effect of effects) effect(); return tree; },
  };
  return api;
}
function elements(tree: any): ReactElement<any>[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== "object" || !tree.props) return [];
  return [tree, ...elements(tree.props.children)];
}
function node(tree: any, type: any, predicate: (p: any) => boolean = () => true) {
  const result = elements(tree).find((e) => e.type === type && predicate(e.props));
  if (!result) throw new Error(`missing node ${type}`);
  return result;
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
beforeEach(() => {
  state.fetch.mockReset(); state.push.mockReset(); state.mutate.mockReset().mockImplementation(async (data: any) => { if (data) state.narrative = data; return data; });
  state.narrative = { narrative: { title: "旧标题", subtitle: "旧副标题", curatorial_statement: "旧策展语", chapters: [], tone: "restrained", source: "heuristic", current_version: 3, edit_revision: 7 }, edits: [] };
  vi.stubGlobal("fetch", state.fetch);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("FieldEditor 单飞与草稿", () => {
  it("双保存返回同一 Promise；保存中只读且屏障等待实际结果", async () => {
    const request = deferred<boolean>();
    const onSave = vi.fn(() => request.promise);
    let saver!: () => Promise<boolean>;
    const register = (save: () => Promise<boolean>) => { saver = save; return () => {}; };
    const h = harness(() => FieldEditor({ value: "旧", locked: false, maxLength: 60, onSave, register }));
    node(h.render(), "button", (p) => p.title === "编辑").props.onClick();
    node(h.render(), "input").props.onChange({ target: { value: "草稿" } });
    h.render();
    const a = saver(); const b = saver();
    expect(b).toBe(a);
    await Promise.resolve();
    expect(onSave).toHaveBeenCalledTimes(1);
    const busy = h.render();
    expect(node(busy, "input").props.readOnly).toBe(true);
    expect(elements(busy).some((e) => e.props.children === "正在保存…")).toBe(true);
    node(busy, "input").props.onChange({ target: { value: "保存期间误输入" } });
    request.resolve(false);
    expect(await a).toBe(false);
    const failed = h.render();
    expect(node(failed, "input").props.value).toBe("草稿");
    expect(node(failed, "span", (p) => p.role === "alert")).toBeTruthy();
  });

  it("已成功但尚未 render 时屏障不再次提交旧 draft", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    let saver!: () => Promise<boolean>;
    const register = (save: () => Promise<boolean>) => { saver = save; return () => {}; };
    const h = harness(() => FieldEditor({ value: "旧", locked: false, maxLength: 60, onSave, register }));
    node(h.render(), "button", (p) => p.title === "编辑").props.onClick();
    node(h.render(), "input").props.onChange({ target: { value: "草稿" } }); h.render();
    expect(await saver()).toBe(true);
    expect(await saver()).toBe(true);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("保存异常也返回 false 并保留 draft，下一次可以重试", async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(true);
    let saver!: () => Promise<boolean>;
    const register = (save: () => Promise<boolean>) => { saver = save; return () => {}; };
    const h = harness(() => FieldEditor({ value: "旧", locked: false, maxLength: 60, onSave, register, multiline: true }));
    node(h.render(), "button", (p) => p.title === "编辑").props.onClick();
    node(h.render(), "textarea").props.onChange({ target: { value: "草稿" } }); h.render();
    expect(await saver()).toBe(false);
    expect(node(h.render(), "textarea").props.value).toBe("草稿");
    expect(await saver()).toBe(true);
  });

  it.each(["取消", "Escape"])("%s 后尚未 render，屏障也不保存已取消草稿", async (action) => {
    const onSave = vi.fn().mockResolvedValue(true);
    let saver!: () => Promise<boolean>;
    const register = (save: () => Promise<boolean>) => { saver = save; return () => {}; };
    const h = harness(() => FieldEditor({ value: "旧", locked: false, maxLength: 60, onSave, register }));
    node(h.render(), "button", (p) => p.title === "编辑").props.onClick();
    node(h.render(), "input").props.onChange({ target: { value: "不要保存的草稿" } });
    const editing = h.render();
    if (action === "Escape") node(editing, "input").props.onKeyDown({ key: "Escape" });
    else node(editing, "button", (p) => p.children === "取消").props.onClick();
    expect(await saver()).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("同字段后台更新时保留旧草稿，不能借用新修订覆盖", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    let value = "旧";
    let saver!: () => Promise<boolean>;
    const register = (save: () => Promise<boolean>) => { saver = save; return () => {}; };
    const h = harness(() => FieldEditor({ value, locked: false, maxLength: 60, onSave, register }));
    node(h.render(), "button", (p) => p.title === "编辑").props.onClick();
    node(h.render(), "input").props.onChange({ target: { value: "我的草稿" } });
    value = "其他标签页刚保存的内容";
    h.render();
    expect(await saver()).toBe(false);
    expect(onSave).not.toHaveBeenCalled();
    const conflicted = h.render();
    expect(node(conflicted, "input").props.value).toBe("我的草稿");
    expect(node(conflicted, "span", (p) => p.role === "alert").props.children).toContain("已在其他操作中更新");
  });
});

describe("NarrativeBoard 确认修订与保存屏障", () => {
  it("连续字段保存使用 narrative 的服务端修订，不用 status，也不依赖下一次 render", async () => {
    const h = harness(() => NarrativeBoard({ exhibitionId: "exh" }));
    const tree = h.render();
    const fields = elements(tree).filter((e) => e.type === FieldEditor);
    state.fetch.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      return { ok: true, json: async () => ({ narrative: { ...state.narrative.narrative, edit_revision: body.expected_edit_revision + 1 }, edits: [] }) };
    });
    expect(await fields[0].props.onSave("标题一", false)).toBe(true);
    expect(await fields[1].props.onSave("副标题二", false)).toBe(true);
    const bodies = state.fetch.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(bodies[0]).toMatchObject({ expected_version: 3, expected_edit_revision: 7 });
    expect(bodies[1]).toMatchObject({ expected_version: 3, expected_edit_revision: 8 });
    expect(state.mutate.mock.calls.every(([data, options]) => data?.narrative && options?.revalidate === false)).toBe(true);
  });

  it("409 不重取/不重试，Next 失败不跳并显示保留草稿文案", async () => {
    const h = harness(() => NarrativeBoard({ exhibitionId: "exh" }));
    const tree = h.render();
    const field = node(tree, FieldEditor);
    field.props.register(() => field.props.onSave("我的草稿", false));
    state.fetch.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: { code: "version_conflict", message: "old message" } }) });
    elements(tree).find((e) => e.props.children === "确认内容，查看版式 →")!.props.onClick();
    await tick();
    expect(state.fetch).toHaveBeenCalledTimes(1);
    expect(state.mutate).not.toHaveBeenCalled();
    expect(state.push).not.toHaveBeenCalled();
    expect(elements(h.render()).some((e) => e.props.children === "内容已在其他操作中更新，你的草稿已保留，请查看最新内容后再保存。")).toBe(true);
  });

  it("屏障等待已经开始的保存，失败不执行后续字段", async () => {
    const barrier = harness(useSaveBarrier).render();
    const saving = deferred<boolean>();
    const later = vi.fn().mockResolvedValue(true);
    barrier.register(() => saving.promise); barrier.register(later);
    const flush = barrier.flush();
    await Promise.resolve(); expect(later).not.toHaveBeenCalled();
    saving.resolve(false); expect(await flush).toBe(false); expect(later).not.toHaveBeenCalled();
  });
});

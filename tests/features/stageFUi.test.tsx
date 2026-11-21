import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AiConnectionStatus } from "@/lib/ai/status";
import { AiUsagePanel } from "@/components/AiUsagePanel";
import { CreateForm } from "@/features/create/CreateForm";
import CreatePage from "@/app/create/page";

type StatusPayload = { defaultMode: "demo" | "ai"; connection: AiConnectionStatus };
const state = vi.hoisted(() => ({
  status: undefined as StatusPayload | undefined,
  statusError: undefined as Error | undefined,
  swr: vi.fn(),
  jsonFetcher: vi.fn(),
  mutate: vi.fn(),
  push: vi.fn(),
  resolveMode: vi.fn(),
  hookValues: null as unknown[] | null,
  hookIndex: 0,
}));

// SSR uses real hooks. Handler tests below use persistent hook slots, not a browser/DOM renderer.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      if (!state.hookValues) return actual.useState(initial);
      const values = state.hookValues;
      const index = state.hookIndex++;
      if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
      return [values[index], (next: unknown) => {
        values[index] = typeof next === "function" ? next(values[index]) : next;
      }];
    },
    useRef: (initial: unknown) => {
      if (!state.hookValues) return actual.useRef(initial);
      const index = state.hookIndex++;
      if (!(index in state.hookValues)) state.hookValues[index] = { current: initial };
      return state.hookValues[index];
    },
  };
});
vi.mock("swr", () => ({ default: state.swr }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock("@/lib/hooks", () => ({ jsonFetcher: state.jsonFetcher }));
vi.mock("@/lib/mode", () => ({ resolveMode: state.resolveMode }));
vi.mock("@/lib/ai/status", () => { throw new Error("Server AI status must remain a type-only import"); });

function connection(overrides: Partial<AiConnectionStatus> = {}): AiConnectionStatus {
  return {
    kind: "configured_untested", label: "已填写配置，尚未测试", detail: "字段完整不代表密钥有效。",
    missing: [], issues: [], lastTestAt: null, lastTestOk: null, lastTestErrorClass: null,
    canTest: true,
    capabilities: {
      text: { state: "untested", at: null, message: null },
      vision: { state: "untested", at: null, message: null },
    },
    ...overrides,
  };
}

beforeEach(() => {
  state.status = { defaultMode: "demo", connection: connection() };
  state.statusError = undefined;
  state.hookValues = null;
  state.hookIndex = 0;
  state.swr.mockReset().mockImplementation(() => ({ data: state.status, error: state.statusError, mutate: state.mutate }));
  state.mutate.mockReset().mockImplementation(async (value?: StatusPayload) => {
    if (value) state.status = value;
    return state.status;
  });
  state.resolveMode.mockReset().mockReturnValue("demo");
  state.push.mockReset();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected request")));
});
afterEach(() => vi.unstubAllGlobals());

const consentLabel = "允许把压缩分析图和必要文字发送给已配置的模型服务，用于本次照片理解与策展。原图保存在本地，压缩副本仍可能包含人物等画面信息。";
const checkboxes = (html: string) => html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
const activeMode = (html: string, mode: string) => expect(html).toMatch(new RegExp(`<button[^>]*aria-pressed="true"[^>]*>${mode}</button>`));

describe("Stage F create UI (static rendering)", () => {
  it.each([undefined, "demo", "ai"] as const)("initializes from default mode %s without granting consent", (defaultMode) => {
    const html = renderToStaticMarkup(<CreateForm demo={false} defaultMode={defaultMode} />);
    activeMode(html, defaultMode === "ai" ? "AI" : "演示");
    expect(checkboxes(html)[1]).not.toContain("checked");
    expect(html).not.toContain('value="在光线转弯之前"');
    expect(fetch).not.toHaveBeenCalled();
  });

  it("explicit demo wins over the AI default and prefills the demo", () => {
    const html = renderToStaticMarkup(<CreateForm demo defaultMode="ai" />);
    activeMode(html, "演示");
    expect(html).toContain('value="在光线转弯之前"');
    expect(html).toContain("想记录一个学期里不断经过的空间");
    expect(checkboxes(html)[1]).not.toContain("checked");
  });

  it.each([undefined, "1"])("the server passes resolveMode with demo=%s", async (demo) => {
    state.resolveMode.mockReturnValue("ai");
    const html = renderToStaticMarkup(await CreatePage({ searchParams: Promise.resolve({ demo }) }));
    expect(state.resolveMode).toHaveBeenCalledOnce();
    activeMode(html, demo === "1" ? "演示" : "AI");
  });

  it("accurately describes compressed-image consent and local-only EXIF", () => {
    const html = renderToStaticMarkup(<CreateForm demo={false} defaultMode="ai" />);
    expect(html).toContain(consentLabel);
    expect(html).toContain("允许在本地读取 EXIF（拍摄时间等）");
    expect(html).toContain("不会向模型发送 GPS、完整元数据或本地文件路径");
    expect(html).not.toContain("允许 AI 使用 EXIF");
    expect(html).not.toContain("分析原图");
    expect(html).not.toContain("MVP 占位");
    expect(html).toContain("不会自动调用模型，也不会自动切回演示模式");
  });

  it("does not block creating/uploading when AI is missing or unconsented", () => {
    state.status!.connection = connection({ kind: "not_configured", canTest: false, missing: ["AI_API_KEY"] });
    const html = renderToStaticMarkup(<CreateForm demo={false} defaultMode="ai" />);
    expect(html).toContain("未完成有效模型配置或未授权时，暂时不能进行 AI 生成");
    expect(html).toMatch(/<button(?=[^>]*type="submit")(?![^>]*disabled)[^>]*>创建并上传照片<\/button>/);
  });
});

describe("Stage F AI status panel (static rendering)", () => {
  const render = () => renderToStaticMarkup(<AiUsagePanel />);

  it("fetches only status with no polling/focus refresh and requires separate probe confirmation", () => {
    const html = render();
    expect(state.swr).toHaveBeenCalledWith("/api/ai/status", state.jsonFetcher, { revalidateOnFocus: false, shouldRetryOnError: false });
    expect(html).toContain("<summary");
    expect(html).toContain("AI 使用说明与连接状态");
    expect(html).toContain("本地演示始终可用");
    expect(html).toContain("两个固定探测");
    expect(html).toContain("最多 2 次模型调用");
    expect(html).toContain("不使用个人照片");
    expect(html).toContain("全局预算");
    expect(html).toContain("每小时连接测试限额");
    expect(html).toContain("这不等于授权影展照片外发");
    expect(checkboxes(html)[0]).not.toContain("checked");
    expect(html).toMatch(/<button(?=[^>]*type="button")(?=[^>]*disabled)[^>]*>测试模型连接<\/button>/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows setup/restart guidance without credential or endpoint inputs", () => {
    state.status!.connection = connection({ kind: "not_configured", label: "AI 未配置", missing: ["AI_API_KEY", "AI_VISION_MODEL"], canTest: false });
    const html = render();
    expect(html).toContain("AI 未配置");
    expect(html).toContain("缺少配置：AI_API_KEY、AI_VISION_MODEL");
    expect(html).toContain("服务端 .env.local");
    expect(html).toContain("重启服务并重新加载状态");
    expect(html).toContain("未设置时复用视觉模型");
    expect(html.match(/<input/g)).toHaveLength(1);
    expect(checkboxes(html)[0]).toContain("disabled");
    expect(html).toContain("本地演示始终可用");
  });

  it("does not equate filled configuration with successful probes", () => {
    const html = render();
    expect(html).toContain("尚未测试");
    expect(html).toContain("文本探测：未测试");
    expect(html).toContain("视觉探测：未测试");
    expect(html).not.toContain("均已通过");
  });

  it.each(["untested", "failed", "running"] as const)("does not claim vision ready after text-only success (vision %s)", (visionState) => {
    state.status!.connection.capabilities.text.state = "succeeded";
    state.status!.connection.capabilities.vision.state = visionState;
    const html = render();
    expect(html).toContain("文本探测：通过");
    expect(html).toContain("文本探测通过不代表视觉可用");
    expect(html).not.toContain("均已通过");
  });

  it("reports both successful probes without guaranteeing future generations", () => {
    state.status!.connection = connection({ kind: "test_succeeded", label: "测试通过", lastTestAt: "2026-11-01T00:00:00Z", lastTestOk: true });
    state.status!.connection.capabilities.text.state = "succeeded";
    state.status!.connection.capabilities.vision.state = "succeeded";
    const html = render();
    expect(html).toContain("文本与视觉探测均已通过");
    expect(html).toContain("不保证每次生成成功");
    expect(html).toContain("最近测试：");
  });

  it("shows configuration issues and failed probe messages, not raw debug", () => {
    state.status!.connection = connection({ kind: "connection_error", label: "配置或连接异常", issues: ["配置无效"], canTest: false, lastTestOk: false, lastTestErrorClass: "internal_error_class" });
    state.status!.connection.capabilities.vision = { state: "failed", at: "2026-11-01T00:00:00Z", message: "视觉探测未通过，请检查模型配置。" };
    const html = render();
    expect(html).toContain("配置问题：配置无效");
    expect(html).toContain("视觉探测：未通过");
    expect(html).toContain("视觉探测未通过，请检查模型配置。");
    expect(html).not.toContain("internal_error_class");
    expect(html).not.toContain("<pre");
  });

  it("shows running probes separately", () => {
    state.status!.connection.capabilities.text.state = "running";
    expect(render()).toContain("文本探测：测试中");
  });

  it("keeps local demo available while loading", () => {
    state.status = undefined;
    const html = render();
    expect(html).toContain("正在加载 AI 连接状态");
    expect(html).toContain("本地演示始终可用");
    expect(checkboxes(html)[0]).toContain("disabled");
  });

  it.each([true, false])("offers local status retry on load errors (cached %s)", (cached) => {
    if (!cached) state.status = undefined;
    state.statusError = new Error("private raw debug");
    const html = render();
    expect(html).toContain("无法加载 AI 连接状态");
    expect(html).toContain("重新加载状态");
    expect(html).toContain("本地演示始终可用");
    expect(html).not.toContain("private raw debug");
    expect(checkboxes(html)[0]).toContain("disabled");
    expect(fetch).not.toHaveBeenCalled();
  });
});

// Traverse returned JSX without mounting nested components. These exercise handlers with mocked
// hooks and fetch; they are not DOM event, hydration, or browser integration tests.
function propsOf<T>(tree: ReactNode, match: (props: Record<string, unknown>) => boolean): T {
  const queue = [tree];
  while (queue.length) {
    const node = queue.shift();
    if (!isValidElement<Record<string, unknown>>(node)) continue;
    if (match(node.props)) return node.props as T;
    queue.push(...Children.toArray(node.props.children as ReactNode));
  }
  throw new Error("JSX element not found");
}
function renderHandlers(component: () => ReactElement) {
  state.hookValues ??= [];
  state.hookIndex = 0;
  return component();
}
const button = (tree: ReactNode, label: string) => propsOf<{ disabled?: boolean; active?: boolean; onClick: () => void | Promise<void> }>(tree, (props) => props.children === label);
const toggle = (tree: ReactNode) => propsOf<{ checked: boolean; onChange: (checked: boolean) => void }>(tree, (props) => props.label === consentLabel);
const probeCheckbox = (tree: ReactNode) => propsOf<{ checked: boolean; onChange: (event: { target: { checked: boolean } }) => void }>(tree, (props) => props.type === "checkbox");
const submit = (tree: ReactNode) => propsOf<{ onSubmit: (event: { preventDefault: () => void }) => Promise<void> }>(tree, (props) => typeof props.onSubmit === "function").onSubmit({ preventDefault: vi.fn() });

function confirmProbe() {
  probeCheckbox(renderHandlers(AiUsagePanel)).onChange({ target: { checked: true } });
  return renderHandlers(AiUsagePanel);
}

describe("Stage F create handlers (mocked hooks, no DOM)", () => {
  it("AI selection never grants consent or calls a model, and rerenders preserve choices", () => {
    const render = (defaultMode: "demo" | "ai" = "demo") => renderHandlers(() => CreateForm({ demo: false, defaultMode }));
    button(render(), "AI").onClick();
    expect(button(render(), "AI").active).toBe(true);
    expect(toggle(render()).checked).toBe(false);
    button(render(), "演示").onClick();
    state.status!.defaultMode = "ai";
    expect(button(render("ai"), "演示").active).toBe(true);
    expect(toggle(render("ai")).checked).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([["demo", true, false], ["ai", false, false], ["ai", true, true]] as const)("submits mode %s, chosen consent %s as %s", async (mode, consent, submittedConsent) => {
    state.status!.connection.canTest = false;
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ id: "exh_new" }), { status: 201 }));
    const render = () => renderHandlers(() => CreateForm({ demo: false, defaultMode: mode }));
    if (consent) toggle(render()).onChange(true);
    await submit(render());
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("/api/exhibitions", expect.objectContaining({ method: "POST" }));
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body).toMatchObject({ mode, allow_external_ai: submittedConsent });
    expect(state.push).toHaveBeenCalledWith("/e/exh_new/material");
  });
});

describe("Stage F probe handlers (mocked hooks, no DOM)", () => {
  it("does not test on render or confirmation alone, and guards calls without consent", async () => {
    const tree = renderHandlers(AiUsagePanel);
    expect(button(tree, "测试模型连接").disabled).toBe(true);
    await button(tree, "测试模型连接").onClick();
    const confirmed = confirmProbe();
    expect(button(confirmed, "测试模型连接").disabled).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["cannotTest", "statusError"])("guards a confirmed action when %s", async (reason) => {
    confirmProbe();
    if (reason === "cannotTest") state.status!.connection.canTest = false;
    else state.statusError = new Error("offline");
    const tree = renderHandlers(AiUsagePanel);
    expect(button(tree, "测试模型连接").disabled).toBe(true);
    await button(tree, "测试模型连接").onClick();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts only the explicit fixed-probe confirmation, guards synchronous double clicks, and updates status", async () => {
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const tree = confirmProbe();
    const click = button(tree, "测试模型连接").onClick;
    const first = click();
    await click();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("/api/ai/connection-test", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true }),
    });
    const pendingTree = renderHandlers(AiUsagePanel);
    expect(propsOf<{ disabled: boolean }>(pendingTree, (props) => props.variant === "outline").disabled).toBe(true);
    const updated = connection();
    updated.capabilities.text.state = "succeeded";
    finish(new Response(JSON.stringify({ connection: updated, results: [{ debug: "must not display" }] })));
    await first;
    expect(state.mutate).toHaveBeenCalledWith({ defaultMode: "demo", connection: updated }, { revalidate: false });
    expect(probeCheckbox(renderHandlers(AiUsagePanel)).checked).toBe(false);
    state.hookValues = null;
    const html = renderToStaticMarkup(<AiUsagePanel />);
    expect(html).toContain("文本探测通过不代表视觉可用");
    expect(html).not.toContain("must not display");
  });

  it("shows a non-2xx error.message and permits a separately confirmed local retry", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "本小时测试额度已用完", debug: "private debug" } }), { status: 429 }));
    await button(confirmProbe(), "测试模型连接").onClick();
    let tree = renderHandlers(AiUsagePanel);
    expect(propsOf<{ children: ReactNode[] }>(tree, (props) => props.role === "alert").children).toContain("本小时测试额度已用完");
    expect(button(tree, "重试连接测试").disabled).toBe(true);
    expect(state.mutate).not.toHaveBeenCalled();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ connection: connection() })));
    tree = confirmProbe();
    await button(tree, "重试连接测试").onClick();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(button(renderHandlers(AiUsagePanel), "测试模型连接").disabled).toBe(true);
  });

  it("handles transport failures without exposing raw error debug", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("secret internal address"));
    await button(confirmProbe(), "测试模型连接").onClick();
    const tree = renderHandlers(AiUsagePanel);
    const alert = propsOf<{ children: ReactNode[] }>(tree, (props) => props.role === "alert");
    expect(alert.children).toContain("连接测试请求未完成，请检查网络后重试。");
    expect(alert.children).not.toContain("secret internal address");
    expect(button(tree, "重试连接测试").disabled).toBe(true);
  });

  it("status retry revalidates status without sending a probe", async () => {
    state.statusError = new Error("offline");
    await button(renderHandlers(AiUsagePanel), "重新加载状态").onClick();
    expect(state.mutate).toHaveBeenCalledWith();
    expect(fetch).not.toHaveBeenCalled();
  });
});

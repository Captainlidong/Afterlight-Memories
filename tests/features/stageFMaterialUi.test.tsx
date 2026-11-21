import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { StatusPayload } from "@/lib/hooks";
import { AiExhibitionSettings } from "@/components/AiExhibitionSettings";
import { ExhibitionUsage } from "@/components/AiUsagePanel";
import { MaterialBoard } from "@/features/material/MaterialBoard";
import { StaleBanner } from "@/components/StaleBanner";

const state = vi.hoisted(() => ({ status: undefined as StatusPayload | undefined, usable: false }));
vi.mock("next/navigation", () => ({ usePathname: () => "/e/test/material" }));
vi.mock("swr", () => ({ default: () => ({ data: { connection: { canTest: state.usable } } }), mutate: vi.fn() }));
vi.mock("@/lib/hooks", () => ({
  jsonFetcher: vi.fn(),
  useStatus: () => ({ data: state.status, mutate: vi.fn() }),
  usePhotos: () => ({ data: { photos: [{ id: "p1", width: 10, height: 10, file_size: 100, original_name: "test.jpg", status: "uploaded" }], inspections: [] }, mutate: vi.fn() }),
}));
vi.mock("@/lib/useWorkflowAdvance", () => ({ useWorkflowAdvance: () => ({ begin: vi.fn() }) }));
vi.mock("@/features/material/UploadZone", () => ({ UploadZone: () => <span>上传入口</span> }));
vi.mock("@/components/AiUsagePanel", async (importOriginal) => ({ ...await importOriginal<object>(), AiUsagePanel: () => <span>连接状态入口</span> }));
vi.mock("@/components/AgentTrace", () => ({ AgentTrace: () => null }));

beforeEach(() => {
  state.usable = false;
  state.status = {
    exhibition: { id: "test", title: "test", status: "draft", failed_stage: null, stale_from: null, current_version: 0, input_revision: 0, selection_confirmed_revision: null, selection_confirmed_photo_ids: null, selection_hold_policy: null, mode: "ai", allow_external_ai: false, is_demo_set: false, selected_motif_id: null, template: "cinema_scroll", tone: "restrained" },
    is_running: false, workflow_id: null, photos: { total: 3, uploaded: 2, inspected: 1, failed: 0 }, progress: { narrative: false, layout: false, qa: false }, runs: [],
  };
});
const analyzeButton = (html: string) => html.match(/<button[^>]*>分析照片并推荐选片<\/button>/)?.[0] ?? "missing";

describe("素材页模式、授权与进度", () => {
  it.each([[false, false], [false, true], [true, false], [true, true]])("配置 %s 授权 %s 才能分析", (usable, consent) => {
    state.usable = usable; state.status!.exhibition.allow_external_ai = consent;
    const html = renderToStaticMarkup(<MaterialBoard exhibitionId="test" autostart={false} />);
    expect(analyzeButton(html)).not.toBe("missing");
    expect(analyzeButton(html).includes("disabled")).toBe(!(usable && consent));
    expect(html).toContain("上传入口");
  });
  it("Demo 不依赖 AI 配置或授权", () => {
    state.status!.exhibition.mode = "demo";
    const html = renderToStaticMarkup(<MaterialBoard exhibitionId="test" autostart={false} />);
    expect(analyzeButton(html)).not.toContain("disabled");
  });
  it("生成时模式切换禁用但撤销授权仍开放", () => {
    state.status!.is_running = true; state.status!.exhibition.allow_external_ai = true;
    const html = renderToStaticMarkup(<AiExhibitionSettings exhibitionId="test" />);
    expect(html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0]).not.toContain("disabled");
    expect(html).toContain("无法收回已发送的数据");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>切换为/);
  });
  it("生成中不允许重新授予授权", () => {
    state.status!.is_running = true;
    const html = renderToStaticMarkup(<AiExhibitionSettings exhibitionId="test" />);
    expect(html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0]).toContain("disabled");
  });
  it("展示实际保存数量，不把旧结果冒充当前完成百分比", () => {
    state.status!.is_running = true;
    const html = renderToStaticMarkup(<MaterialBoard exhibitionId="test" autostart={false} />);
    expect(html).toContain("已保存分析 1/3 张");
    expect(html).toContain("包含之前保存的结果");
    expect(html).not.toContain("100%");
  });
  it("显示服务端复用和请求数，未知消耗与未定价不伪装为零费用", () => {
    state.status!.ai_usage = {
      workflow_id: "w", activity: { queued: 0, in_flight: 0 }, run: { attempts: 1, succeeded: 0, failed: 1, uncertain: 0, unknown_usage: 1, known_total_tokens: null, duration_ms: 1200, models: ["test-vision"], errors: ["invalid_response"] },
      business: { used: 31, limit: 40, remaining: 9 }, daily: { used: 33, limit: 100, remaining: 67, timezone: "Asia/Shanghai" },
      probes: { hourly_used: 2, hourly_limit: 5, latest_attempts: 2, latest_at: "2026-11-20T00:00:00Z" },
      material: { run_id: "r", workflow_id: "w", current_input: true, total: 30, processed: 29, reused: 29, newly_completed: 0, failed: 1, pending: 0 }, cost: "unpriced",
    };
    const html = renderToStaticMarkup(<ExhibitionUsage exhibitionId="test" />);
    expect(html).toContain("29/30 张已完成");
    expect(html).toContain("复用 29 张");
    expect(html).toContain("本次已发送 1 次请求");
    expect(html).toContain("剩余 9 次");
    expect(html).toContain("消耗未知");
    expect(html).toContain("未配置价格，暂不估算费用");
    expect(html).not.toContain("0 元");
    expect(html).toContain("连接测试");
    state.status!.workflow_id = "w";
    state.status!.is_running = true;
    state.status!.runs = [
      { id: "active", agent_type: "material_steward", status: "running", workflow_id: "w", input_version: 0, input_revision: 0, created_at: "2026-11-20", finished_at: null, duration_ms: null, error_message: null },
      { id: "future", agent_type: "aesthetic_selector", status: "pending", workflow_id: "w", input_version: 0, input_revision: 0, created_at: "2026-11-20", finished_at: null, duration_ms: null, error_message: null },
    ];
    state.status!.ai_usage.activity = { queued: 1, in_flight: 0 };
    const queued = renderToStaticMarkup(<ExhibitionUsage exhibitionId="test" />);
    expect(queued).toContain("读取照片 · 正在排队");
    expect(queued).toContain("本次排队 1 个，正在处理 0 个请求");
    expect(queued).not.toContain("推荐选片 ·");
    state.status!.ai_usage.activity = { queued: 0, in_flight: 1 };
    expect(renderToStaticMarkup(<ExhibitionUsage exhibitionId="test" />)).toContain("正在请求模型");
  });
  it("失败原因与下一步默认可见，技术详情保持折叠", () => {
    state.status!.exhibition.failed_stage = "narrative";
    state.status!.runs = [{ id: "r", agent_type: "narrative_editor", status: "failed", workflow_id: "w", input_version: 0, input_revision: 0, created_at: "2026-11-20", finished_at: null, duration_ms: 1, error_message: "额度耗尽，请等待恢复" }];
    const html = renderToStaticMarkup(<StaleBanner exhibitionId="test" />);
    expect(html).toContain("之前保存的内容仍在");
    expect(html.indexOf("额度耗尽，请等待恢复")).toBeLessThan(html.indexOf("<details"));
    expect(html).toContain("检查模式、授权与连接状态");
    expect(html).toContain("重试这一步");
  });
});

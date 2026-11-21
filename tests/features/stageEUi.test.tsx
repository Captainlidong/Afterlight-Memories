import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunSummary, StatusPayload } from "@/lib/hooks";
import type { AgentRun, MotifDTO, NarrativeDTO } from "@/types";
import { NarrativeBoard } from "@/features/narrative/NarrativeBoard";
import { BrowseView } from "@/features/exhibition/BrowseView";
import { MotifsBoard } from "@/features/motifs/MotifsBoard";
import { AgentTrace } from "@/components/AgentTrace";

const state = vi.hoisted(() => ({
  status: undefined as StatusPayload | undefined,
  statusError: undefined as Error | undefined,
  narrative: undefined as NarrativeDTO | undefined,
  motifs: undefined as { motifs: MotifDTO[] } | undefined,
  motifError: undefined as Error | undefined,
  motifLoading: false,
  motifValidating: false,
  trace: undefined as { run: AgentRun } | undefined,
  openTrace: false,
  mutate: vi.fn(),
}));

// Node-only rendering: seed the modal's selected run instead of requiring a DOM dependency.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      if (state.openTrace && initial === null) {
        state.openTrace = false;
        return actual.useState("run_1");
      }
      return actual.useState(initial);
    },
  };
});
vi.mock("swr", () => ({ default: () => ({ data: state.trace }), mutate: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/useLandingFocus", () => ({ useLandingFocus: () => [null, null] }));
vi.mock("@/lib/useWorkflowAdvance", () => ({ useWorkflowAdvance: () => ({ begin: vi.fn() }) }));
vi.mock("@/lib/hooks", () => ({
  jsonFetcher: vi.fn(),
  useStatus: () => ({ data: state.status, error: state.statusError, mutate: state.mutate }),
  usePhotos: () => ({ data: { photos: [{ id: "p1" }] } }),
  useNarrative: () => ({ data: { narrative: state.narrative, edits: [] }, mutate: state.mutate }),
  useVersions: () => ({ data: { versions: [] }, mutate: state.mutate }),
  useMotifs: () => ({
    data: state.motifs,
    error: state.motifError,
    isLoading: state.motifLoading,
    isValidating: state.motifValidating,
    mutate: state.mutate,
  }),
  usePreview: () => ({
    data: { narrative: state.narrative, layout: { sections: [], updated_at: "v1" }, photos: [] },
    mutate: state.mutate,
  }),
}));
vi.mock("@/features/narrative/ChapterTree", () => ({ ChapterTree: () => null }));
vi.mock("@/components/exhibition/LayoutRenderer", () => ({ LayoutRenderer: () => null }));
vi.mock("@/features/exhibition/useExhibitionPlayback", () => ({ useExhibitionPlayback: () => ({}) }));
vi.mock("@/features/exhibition/PlaybackControls", () => ({ PlaybackControls: () => null }));
vi.mock("@/components/ExportButtons", () => ({ ExportButtons: () => null }));

function run(status: RunSummary["status"] = "completed", id = "run_1"): RunSummary {
  return {
    id, agent_type: "motif_finder", status, input_version: 0, workflow_id: "wf_1",
    input_revision: 1, duration_ms: 20, error_message: null,
    created_at: "2026-01-01T00:00:00.000Z", finished_at: "2026-01-01T00:00:01.000Z",
  };
}

beforeEach(() => {
  state.status = {
    exhibition: {
      id: "exh_test", title: "影展", status: "awaiting_motif_selection", failed_stage: null,
      stale_from: null, current_version: 0, input_revision: 1, selection_confirmed_revision: 1,
      selection_confirmed_photo_ids: ["p1"], selection_hold_policy: "exclude", mode: "ai", allow_external_ai: true,
      is_demo_set: false, selected_motif_id: null, template: "cinema_scroll", tone: "restrained",
    },
    is_running: false, workflow_id: "wf_1", photos: { total: 1, uploaded: 0, inspected: 1, failed: 0 },
    progress: { narrative: false, layout: false, qa: false }, runs: [],
  };
  state.narrative = {
    exhibition_id: "exh_test", selected_motif_id: "m1", title: "光线", subtitle: "", curatorial_statement: "",
    tone: "restrained", source: "ai", chapters: [], input_version: 0, current_version: 0, edit_revision: 0, run_id: "run_1", updated_at: "v1",
  };
  state.motifs = { motifs: [] };
  state.statusError = undefined;
  state.motifError = undefined;
  state.motifLoading = false;
  state.motifValidating = false;
  state.trace = undefined;
  state.openTrace = false;
  state.mutate.mockClear();
});

const sources = [
  ["ai", "AI 分析/生成"],
  ["ai_cache", "AI 已有分析，本次未重新发送"],
  ["demo_preset", "演示预设"],
  ["heuristic", "本地规则"],
  ["legacy_source", "来源未记录"],
  ["", "来源未记录"],
  ["mixed", "来源未记录"],
] as const;

describe("Stage E narrative provenance", () => {
  it.each(sources)("NarrativeBoard honestly labels %s", (source, label) => {
    state.narrative!.source = source;
    const html = renderToStaticMarkup(<NarrativeBoard exhibitionId="exh_test" />);
    expect(html).toContain(label);
    if (source !== "demo_preset") expect(html).not.toContain("演示预设");
    if (source !== "heuristic") expect(html).not.toContain("本地规则");
  });

  it.each(sources)("BrowseView does not infer Demo or AI for %s", (source, label) => {
    state.narrative!.source = source;
    const html = renderToStaticMarkup(<BrowseView exhibitionId="exh_test" />);
    if (source === "demo_preset" || source === "heuristic") {
      expect(html).toContain("演示模式");
      expect(html).toContain(source === "heuristic" ? "本地规则分析" : "本地示例分析结果");
    } else {
      expect(html).toContain(label);
      expect(html).not.toContain("演示模式");
      if (label === "来源未记录") expect(html).not.toContain("AI");
    }
  });
});

describe("Stage E motif result states", () => {
  const render = () => renderToStaticMarkup(<MotifsBoard exhibitionId="exh_test" />);

  it("shows insufficient evidence only for a completed empty result", () => {
    state.status!.runs = [run()];
    const html = render();
    expect(html).toContain("当前素材不足以支持主题");
    expect(html).toContain("调整选片或策展意图");
    expect(html).toContain("重新发现");
  });

  it("does not promise 2–4 themes before discovering", () => {
    const html = render();
    expect(html).toContain("还没有候选主题");
    expect(html).not.toContain("2–4");
    expect(html).not.toContain("当前素材不足以支持主题");
  });

  it("reports one theme honestly", () => {
    state.status!.runs = [run()];
    state.motifs = { motifs: [{
      id: "m1", exhibition_id: "exh_test", title: "窗", user_title: null, effective_title: "窗",
      description: "重复的窗框", photo_ids: [], evidence: ["窗框反复出现"], confidence: 0.8,
      alternative_readings: [], state: "proposed", run_id: "run_1", created_at: "2026-01-01",
    }] };
    const html = render();
    expect(html).toContain("找到 1 个候选母题");
    expect(html).not.toContain("2–4");
    expect(html).not.toContain("当前素材不足以支持主题");
  });

  it.each(["running", "pending", "failed", "skipped"] as const)("a newer %s run overrides an older completed run", (status) => {
    state.status!.runs = [run(), run(status, "run_2")];
    expect(render()).not.toContain("当前素材不足以支持主题");
  });

  it("ignores completed runs belonging to other agents", () => {
    state.status!.runs = [{ ...run(), agent_type: "aesthetic_selector" }];
    expect(render()).not.toContain("当前素材不足以支持主题");
  });

  it("does not show insufficiency while a workflow is running", () => {
    state.status!.runs = [run()];
    state.status!.is_running = true;
    expect(render()).not.toContain("当前素材不足以支持主题");
  });

  it.each(["loading", "validating", "missing"])("does not show insufficiency for %s motif data", (mode) => {
    state.status!.runs = [run()];
    state.motifLoading = mode === "loading";
    state.motifValidating = mode === "validating";
    if (mode === "missing") state.motifs = undefined;
    const html = render();
    expect(html).not.toContain("当前素材不足以支持主题");
    expect(html).toContain("加载候选主题");
  });

  it.each([true, false])("shows a retryable fetch error, cached data: %s", (cached) => {
    state.status!.runs = [run()];
    state.motifError = new Error("offline");
    if (!cached) state.motifs = undefined;
    const html = render();
    expect(html).toContain("无法加载候选主题");
    expect(html).toContain("重试");
    expect(html).not.toContain("当前素材不足以支持主题");
  });

  it("does not use failed status refreshes as proof of insufficiency", () => {
    state.status!.runs = [run()];
    state.statusError = new Error("offline");
    expect(render()).not.toContain("当前素材不足以支持主题");
  });
});

describe("Stage E AgentTrace provenance", () => {
  function render(output: unknown) {
    state.openTrace = true;
    state.trace = { run: { ...run(), exhibition_id: "exh_test", input_json: {}, output_json: output } };
    return renderToStaticMarkup(<AgentTrace exhibitionId="exh_test" runs={[run()]} />);
  }

  it.each([...sources.filter(([source]) => source !== "mixed"), ["mixed", "混合来源"] as const])(
    "displays %s outside technical details and preserves exact provenance JSON",
    (source, label) => {
      const provenance = {
        source, provider: "provider_test", model: "model_test", prompt_version: "prompt_v1",
        schema_version: "schema_v2", preprocess_version: "preprocess_v3", call_id: null, cache_hit: source === "ai_cache",
      };
      const html = render({ provenance, motifs: [] });
      const detailsIndex = html.indexOf("<details>");
      expect(detailsIndex).toBeGreaterThan(0);
      expect(html.slice(0, detailsIndex)).toContain(label);
      const expectedJson = renderToStaticMarkup(<pre>{JSON.stringify({ provenance, motifs: [] }, null, 2)}</pre>);
      expect(html.slice(detailsIndex)).toContain(expectedJson.replace(/^<pre>|<\/pre>$/g, ""));
      expect(html.slice(0, detailsIndex)).not.toContain("provider_test");
    },
  );

  it.each([null, "legacy output", [], { motifs: [] }, { provenance: null }, { provenance: "ai" }])(
    "accepts arbitrary old output without inventing a source: %j", (output) => {
      const html = render(output);
      expect(html).not.toContain("AI 分析/生成");
      expect(html).not.toContain("演示预设");
      expect(html).not.toContain("来源未记录");
    },
  );
});

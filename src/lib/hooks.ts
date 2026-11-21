import useSWR, { mutate } from "swr";
import type { PhotoAsset, CurationDecisionDTO, MotifDTO, NarrativeDTO, UserEditDTO, VersionSummary, Exhibition, LayoutDTO, QaDTO } from "@/types";
import type { PhotoInspectionT, AgentTypeT, RunStatusT } from "@/lib/agents/schemas";
import type { DecisionCounts } from "@/lib/db/curation";
import type { UndoableOperationSummary } from "@/lib/db/curationOperations";
import type { ExhibitionAiUsage } from "@/lib/ai/usage";

export const jsonFetcher = (url: string) =>
  fetch(url).then(async (r) => {
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message ?? "请求失败");
    return data;
  });

export interface RunSummary {
  id: string;
  agent_type: AgentTypeT;
  status: RunStatusT;
  input_version: number;
  workflow_id: string | null;
  input_revision: number | null;
  duration_ms: number | null;
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface StatusPayload {
  exhibition: {
    id: string;
    title: string;
    status: string;
    failed_stage: string | null;
    stale_from: string | null;
    current_version: number;
    input_revision: number;
    selection_confirmed_revision: number | null;
    selection_confirmed_photo_ids: string[] | null;
    selection_hold_policy: "exclude" | "include" | null;
    mode: "demo" | "ai";
    allow_external_ai: boolean;
    is_demo_set: boolean;
    selected_motif_id: string | null;
    template: string;
    tone: string;
  };
  is_running: boolean;
  workflow_id: string | null;
  photos: { total: number; uploaded: number; inspected: number; failed: number };
  ai_usage?: ExhibitionAiUsage | null;
  progress: { narrative: boolean; layout: boolean; qa: boolean };
  runs: RunSummary[];
}

export interface PhotosPayload {
  photos: PhotoAsset[];
  inspections: PhotoInspectionT[];
}

/**
 * 状态轮询：运行中 800ms，空闲停轮询（演示可靠性优先，非 SSE）。
 * 工厂而非模块常量：SWR 轮询 effect 依赖 refreshInterval 的函数标识，
 * 每次渲染返回新引用才会按最新 is_running 动态启停；稳定引用会令轮询永不启动。
 */
export function statusPollingOptions() {
  return {
    refreshInterval: (latest?: StatusPayload) => (latest?.is_running ? 800 : 0),
    revalidateOnFocus: true,
    // 后台标签页也继续轮询：否则切走后管线完成看不到终态，自动前进失效（§19.2 B）。
    refreshWhenHidden: true,
  };
}

export function useStatus(id: string) {
  return useSWR<StatusPayload>(`/api/exhibitions/${id}/status`, jsonFetcher, statusPollingOptions());
}

export function usePhotos(id: string) {
  return useSWR<PhotosPayload>(`/api/exhibitions/${id}/photos`, jsonFetcher, {
    refreshInterval: 0,
  });
}

export interface CurationPayload {
  decisions: CurationDecisionDTO[];
  counts: DecisionCounts;
  revision: number;
  latest_undoable_operation: UndoableOperationSummary | null;
}

/** 筛选结果轮询：select 运行中 800ms，空闲停轮询；PATCH 后由调用方 mutate。 */
export function useCuration(id: string, running = false) {
  return useSWR<CurationPayload>(`/api/exhibitions/${id}/curation`, jsonFetcher, {
    refreshInterval: running ? 800 : 0,
    revalidateOnFocus: true,
  });
}

/** 批量/撤销/单张修改后使该影展的全部 SWR 缓存失效（§19.5.10），不只当前可见分组。 */
export function invalidateExhibition(id: string) {
  return mutate((key) => typeof key === "string" && key.startsWith(`/api/exhibitions/${id}/`));
}

export interface MotifsPayload {
  motifs: MotifDTO[];
}

/** 候选主题轮询：motifs 运行中 800ms，空闲停轮询；select/PATCH 后由调用方 mutate。 */
export function useMotifs(id: string, running = false) {
  return useSWR<MotifsPayload>(`/api/exhibitions/${id}/motifs`, jsonFetcher, {
    refreshInterval: running ? 800 : 0,
    revalidateOnFocus: true,
  });
}

export interface NarrativePayload {
  narrative: NarrativeDTO | null;
  edits: UserEditDTO[];
}

/** 叙事轮询：narrative 运行中 800ms，空闲停轮询；PATCH/regenerate 后由调用方 mutate。 */
export function useNarrative(id: string, running = false) {
  return useSWR<NarrativePayload>(`/api/exhibitions/${id}/narrative`, jsonFetcher, {
    refreshInterval: running ? 800 : 0,
    revalidateOnFocus: true,
  });
}

export interface VersionsPayload {
  versions: VersionSummary[];
}

/** 版本摘要：空闲停轮询；快照/回滚后由调用方 mutate。 */
export function useVersions(id: string) {
  return useSWR<VersionsPayload>(`/api/exhibitions/${id}/versions`, jsonFetcher, {
    refreshInterval: 0,
  });
}

export interface PreviewPayload {
  exhibition: Exhibition;
  narrative: NarrativeDTO | null;
  layout: LayoutDTO | null;
  photos: PhotoAsset[];
}

/** 浏览/预览 bundle：layout 运行中 800ms 轮询，空闲停；换模板/重新排版后由调用方 mutate。 */
export function usePreview(id: string, running = false) {
  return useSWR<PreviewPayload>(`/api/exhibitions/${id}/preview`, jsonFetcher, {
    refreshInterval: running ? 800 : 0,
    revalidateOnFocus: true,
  });
}

export interface QaPayload {
  qa: QaDTO | null;
}

/** 质检报告：运行中 800ms 轮询；忽略/修复后由调用方 mutate。 */
export function useQa(id: string, running = false) {
  return useSWR<QaPayload>(`/api/exhibitions/${id}/qa`, jsonFetcher, {
    refreshInterval: running ? 800 : 0,
    revalidateOnFocus: true,
  });
}
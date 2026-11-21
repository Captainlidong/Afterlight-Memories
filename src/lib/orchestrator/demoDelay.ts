import type { Stage } from "./stateMachine";
import type { Exhibition } from "@/types";

/**
 * Demo 模式每阶段确定性延时 500–1200ms，让智能体轨迹可见地逐段推进（计划·演示节奏）。
 * 由 (exhibitionId, stage) 哈希决定，重跑结果一致；ingest 已有真实 sharp 耗时，不叠加。
 * AFTERLIGHT_DEMO_DELAY=0 关闭（测试与快速彩排用）。徽章已诚实标注演示模式。
 */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function demoStageDelayMs(
  stage: Stage,
  exh: Pick<Exhibition, "id" | "mode">,
): number {
  if (exh.mode !== "demo" || stage === "ingest") return 0;
  if (process.env.AFTERLIGHT_DEMO_DELAY === "0") return 0;
  return 500 + (hash(`${exh.id}:${stage}`) % 701);
}

export async function demoStageDelay(
  stage: Stage,
  exh: Pick<Exhibition, "id" | "mode">,
): Promise<void> {
  const ms = demoStageDelayMs(stage, exh);
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}
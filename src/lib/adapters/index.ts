import type { RunMode } from "../mode";
import { demoVisionAdapter } from "./demoAdapter";
import { demoCurationAdapter } from "./demoCurationAdapter";
import { demoMotifAdapter } from "./demoMotifAdapter";
import { demoNarrativeAdapter } from "./demoNarrativeAdapter";
import { createAiCurationAdapter } from "./aiCurationAdapter";
import { createAiMotifAdapter } from "./aiMotifAdapter";
import { createAiNarrativeAdapter } from "./aiNarrativeAdapter";
import type { AiTextAdapterOptions } from "./aiTextAdapter";
import { createAiVisionAdapter, type AiVisionAdapterOptions } from "./aiVisionAdapter";
import type { VisionAdapter, CurationAdapter, MotifAdapter, NarrativeAdapter } from "./types";

export function getVisionAdapter(mode: RunMode, options?: AiVisionAdapterOptions): VisionAdapter {
  if (mode === "demo") return demoVisionAdapter;
  if (!options) throw new Error("AI 视觉适配器需要服务端数据库上下文。");
  return createAiVisionAdapter(options);
}

export function getCurationAdapter(mode: RunMode, options?: AiTextAdapterOptions): CurationAdapter {
  if (mode === "demo") return demoCurationAdapter;
  if (!options) throw new Error("AI 策展适配器需要服务端数据库与工作流上下文。");
  return createAiCurationAdapter(options);
}

export function getMotifAdapter(mode: RunMode, options?: AiTextAdapterOptions): MotifAdapter {
  if (mode === "demo") return demoMotifAdapter;
  if (!options) throw new Error("AI 策展适配器需要服务端数据库与工作流上下文。");
  return createAiMotifAdapter(options);
}

export function getNarrativeAdapter(mode: RunMode, options?: AiTextAdapterOptions): NarrativeAdapter {
  if (mode === "demo") return demoNarrativeAdapter;
  if (!options) throw new Error("AI 策展适配器需要服务端数据库与工作流上下文。");
  return createAiNarrativeAdapter(options);
}

export type { VisionAdapter, VisionInput, VisionDescription, CurationAdapter, CurationInput, CurationPhotoInput, MotifAdapter, MotifInput, MotifPhotoInput, NarrativeAdapter, NarrativeInput, NarrativePhotoInput, NarrativeMotifInput } from "./types";
import { AdapterNotConfiguredError } from "../api/errors";
import type { CurationAdapter, MotifAdapter, NarrativeAdapter } from "./types";

/** 选片、主题与叙事将在阶段 E 接入；视觉适配器已独立实现。 */
export const aiStubCurationAdapter: CurationAdapter = {
  async curate(): Promise<never> {
    throw new AdapterNotConfiguredError();
  },
};

export const aiStubMotifAdapter: MotifAdapter = {
  async discover(): Promise<never> {
    throw new AdapterNotConfiguredError();
  },
};

export const aiStubNarrativeAdapter: NarrativeAdapter = {
  async compose(): Promise<never> {
    throw new AdapterNotConfiguredError();
  },
};
import { nanoid } from "nanoid";

/** URL 安全 ID，带实体前缀：exh_ / photo_ / run_ / motif_ … */
export function newId(prefix: string): string {
  return `${prefix}_${nanoid(12)}`;
}

export function now(): string {
  return new Date().toISOString();
}
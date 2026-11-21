export type RunMode = "demo" | "ai";

/** 全局默认运行模式。新影展创建时继承此值，也可单独覆盖。 */
export function resolveMode(): RunMode {
  return process.env.AFTERLIGHT_MODE === "ai" ? "ai" : "demo";
}

export function isDemo(mode: RunMode): boolean {
  return mode === "demo";
}
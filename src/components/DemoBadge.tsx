"use client";

/**
 * 诚实的演示模式徽章（设计文档 §14.3）。
 * preset：命中内置示例分析结果；heuristic：自有照片走本地规则分析。
 * compact：浏览页紧凑徽章，固定于左上角，不遮照片与底部播放条。
 * 默认：编辑页头部内联徽章，不再悬浮遮挡底部操作栏。
 */
export function DemoBadge({
  variant = "preset",
  compact = false,
}: {
  variant?: "preset" | "heuristic";
  compact?: boolean;
}) {
  const text =
    variant === "preset"
      ? "演示模式：本次影展使用本地示例分析结果。接入视觉模型后，可分析新的照片批次。"
      : "演示模式：使用本地规则分析（未接入模型）。";

  if (compact) {
    return (
      <details className="fixed left-3 top-14 z-30 max-w-xs">
        <summary className="inline-flex min-h-8 cursor-pointer items-center gap-1 rounded-full border border-gold/30 bg-ink/85 px-3 text-[11px] text-gold/90 backdrop-blur">
          演示模式 ▾
        </summary>
        <div className="mt-1 rounded-md border border-gold/30 bg-ink/95 px-3 py-2 text-[11px] leading-relaxed text-gold/90 backdrop-blur">
          {text}
        </div>
      </details>
    );
  }

  return (
    <details className="relative shrink-0">
      <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1 rounded-full border border-gold/30 px-3 text-[11px] text-gold/90 transition-colors hover:border-gold/60 [&::-webkit-details-marker]:hidden">
        演示模式 ▾
      </summary>
      <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-md border border-gold/30 bg-ink/95 px-3 py-2 text-[11px] leading-relaxed text-gold/90 shadow-lg backdrop-blur">
        {text}
      </div>
    </details>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useStatus } from "@/lib/hooks";

/**
 * 向导步骤条（§19.1 A/F）：普通用户语言 + 真实完成态。
 * 未解锁的步骤不可点击；完成的步骤打勾；当前页高亮。
 */
export function Stepper({ exhibitionId }: { exhibitionId: string }) {
  const pathname = usePathname();
  const { data } = useStatus(exhibitionId);
  const exh = data?.exhibition;
  const progress = data?.progress;

  const selectionConfirmed = exh?.selection_confirmed_revision != null;
  const themeChosen = exh?.selected_motif_id != null;
  const hasNarrative = progress?.narrative ?? false;
  const hasQa = progress?.qa ?? false;

  const steps = [
    { seg: "material", label: "上传照片", done: (data?.photos.inspected ?? 0) > 0, unlocked: true },
    { seg: "selection", label: "确认选片", done: selectionConfirmed, unlocked: true },
    { seg: "motifs", label: "选择主题", done: themeChosen, unlocked: selectionConfirmed },
    { seg: "narrative", label: "调整内容", done: hasNarrative && (progress?.layout ?? false), unlocked: themeChosen },
    { seg: "layout", label: "预览版式", done: hasQa, unlocked: hasNarrative },
  ];

  return (
    <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-6 pb-3">
      {steps.map((s, i) => {
        const active = pathname.includes(`/${s.seg}`);
        const cls = `whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors ${
          active ? "bg-gold/10 text-gold" : s.unlocked ? "text-muted hover:text-text" : "cursor-not-allowed text-muted/40"
        }`;
        const text = `${s.done ? "✓" : `${i + 1}.`} ${s.label}`;
        return s.unlocked ? (
          <Link key={s.seg} href={`/e/${exhibitionId}/${s.seg}`} className={cls}>
            {text}
          </Link>
        ) : (
          <span key={s.seg} className={cls} title="完成前一步后解锁">
            {text}
          </span>
        );
      })}
      {hasQa ? (
        <Link
          href={`/exhibition/${exhibitionId}`}
          className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors ${
            pathname.startsWith("/exhibition/") ? "bg-gold/10 text-gold" : "text-muted hover:text-text"
          }`}
        >
          6. 观看影展
        </Link>
      ) : (
        <span className="cursor-not-allowed whitespace-nowrap rounded-md px-3 py-1.5 text-sm text-muted/40" title="完成前一步后解锁">
          6. 观看影展
        </span>
      )}
    </nav>
  );
}
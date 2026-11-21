"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useStatus } from "@/lib/hooks";
import { readNotice, clearNotice, noticeShouldShow } from "@/lib/advanceNotice";

const LABELS: Record<string, string> = {
  awaiting_selection_confirm: "查看选片结果",
  awaiting_theme_choice: "查看主题",
  awaiting_user_review: "查看内容",
};

/** 离开触发页后工作流在后台完成 → 可点击通知，绝不自动拉回（§19.2）。 */
export function AdvanceNotice({ exhibitionId }: { exhibitionId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data } = useStatus(exhibitionId);
  const notice = typeof window === "undefined" ? null : readNotice(sessionStorage, exhibitionId);
  const show = noticeShouldShow({ notice, status: data, currentPath: pathname ?? "" });

  useEffect(() => {
    if (!notice) return;
    if ((data && data.workflow_id !== notice.workflowId) || pathname === notice.targetPath) {
      clearNotice(sessionStorage, exhibitionId);
    }
  }, [notice, data, pathname, exhibitionId]);

  if (!show || !notice) return null;
  const label = LABELS[notice.expectedStatus] ?? "查看结果";
  return (
    <div
      role="status"
      className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-md border border-gold/40 bg-gold/10 px-4 py-3"
    >
      <span className="text-sm text-text">后台已完成，可以{label}。</span>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => {
          clearNotice(sessionStorage, exhibitionId);
          router.push(notice.targetPath);
        }}
      >
        {label} →
      </button>
    </div>
  );
}
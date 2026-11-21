"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useStatus } from "./hooks";
import { shouldAdvance } from "./workflowAdvance";
import { markLandingFocus } from "./landingFocus";
import { writeNotice, clearNotice } from "./advanceNotice";

/**
 * 工作流完成后自动进入下一步（§19.1 B / §19.2）。
 * begin() 乐观写入通知（触发页随时可能卸载，离页检测不能依赖它存活）；
 * 通知是否显示由 noticeShouldShow 按实时状态裁决：完成 + 到期望门 + 不在目标页才露出。
 * 仍留在触发页 → replace 一次并清掉通知；自动前进绝不拉回已离开的用户。
 */
export function useWorkflowAdvance(
  exhibitionId: string,
  opts: { expectedStatus: string; targetPath: string },
) {
  const router = useRouter();
  const pathname = usePathname();
  const { data } = useStatus(exhibitionId);
  const [pending, setPending] = useState<{ workflowId: string; originPath: string } | null>(null);

  const begin = useCallback(
    (workflowId: string) => {
      writeNotice(sessionStorage, exhibitionId, {
        workflowId,
        expectedStatus: opts.expectedStatus,
        targetPath: opts.targetPath,
      });
      setPending({ workflowId, originPath: pathname });
    },
    [pathname, exhibitionId, opts.expectedStatus, opts.targetPath],
  );

  // 用户主动离开触发页 → 派生为空，不再跟踪；通知已在 begin 时写入，由 AdvanceNotice 裁决显示。
  const active = pending && pathname === pending.originPath ? pending : null;

  useEffect(() => {
    if (!active || !data) return;
    const key = `afterlight.advance.${exhibitionId}.${active.workflowId}`;
    const consumed = sessionStorage.getItem(key) === "1";
    if (
      shouldAdvance({
        pendingWorkflowId: active.workflowId,
        status: data,
        expectedStatus: opts.expectedStatus,
        currentPath: pathname,
        originPath: active.originPath,
        consumed,
      })
    ) {
      sessionStorage.setItem(key, "1");
      clearNotice(sessionStorage, exhibitionId);
      markLandingFocus(sessionStorage, exhibitionId);
      router.replace(opts.targetPath);
      return;
    }
    // 同一工作流已停在别的终态（失败/其他门）→ 本次跟踪结束，交给失败横幅。
    if (
      data.workflow_id === active.workflowId &&
      !data.is_running &&
      data.exhibition.status !== opts.expectedStatus
    ) {
      clearNotice(sessionStorage, exhibitionId);
    }
  }, [data, active, pathname, exhibitionId, opts.expectedStatus, opts.targetPath, router]);

  return { begin, pendingWorkflowId: active?.workflowId ?? null };
}
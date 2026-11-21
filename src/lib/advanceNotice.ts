import type { KVStorage } from "./landingFocus";

export type { KVStorage };

export interface AdvanceNotice {
  workflowId: string;
  expectedStatus: string;
  targetPath: string;
}

const noticeKey = (exhibitionId: string) => `afterlight.notice.${exhibitionId}`;

export function writeNotice(storage: KVStorage, exhibitionId: string, notice: AdvanceNotice): void {
  storage.setItem(noticeKey(exhibitionId), JSON.stringify(notice));
}

export function readNotice(storage: KVStorage, exhibitionId: string): AdvanceNotice | null {
  const raw = storage.getItem(noticeKey(exhibitionId));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<AdvanceNotice>;
    if (typeof v.workflowId !== "string" || typeof v.expectedStatus !== "string" || typeof v.targetPath !== "string") {
      return null;
    }
    return { workflowId: v.workflowId, expectedStatus: v.expectedStatus, targetPath: v.targetPath };
  } catch {
    return null;
  }
}

export function clearNotice(storage: KVStorage, exhibitionId: string): void {
  storage.removeItem(noticeKey(exhibitionId));
}

/** 用户离开触发页后，工作流在后台到达期望门 → 显示可点击通知（不自动拉回）。 */
export function noticeShouldShow(input: {
  notice: AdvanceNotice | null;
  status: { workflow_id: string | null; is_running: boolean; exhibition: { status: string } } | undefined;
  currentPath: string;
}): boolean {
  const { notice, status, currentPath } = input;
  if (!notice || !status) return false;
  return (
    status.workflow_id === notice.workflowId &&
    !status.is_running &&
    status.exhibition.status === notice.expectedStatus &&
    currentPath !== notice.targetPath
  );
}
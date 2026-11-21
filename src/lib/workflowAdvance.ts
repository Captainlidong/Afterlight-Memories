/**
 * 自动前进判定（任务书 v2 §19.1 B）。只绑定「本次触发的工作流」：
 * workflow_id 匹配 + 已到期望休息态 + 用户仍在触发页 + 未消费过，才允许跳转。
 * HTTP 202 只代表已受理，is_running 或中间态一律不跳。
 */
export interface AdvanceInput {
  pendingWorkflowId: string | null;
  status:
    | {
        workflow_id: string | null;
        is_running: boolean;
        exhibition: { status: string };
      }
    | undefined;
  expectedStatus: string;
  currentPath: string;
  originPath: string;
  consumed: boolean;
}

export function shouldAdvance(input: AdvanceInput): boolean {
  const { pendingWorkflowId, status, expectedStatus, currentPath, originPath, consumed } = input;
  if (!pendingWorkflowId || !status || consumed) return false;
  if (status.workflow_id !== pendingWorkflowId) return false;
  if (status.is_running) return false;
  if (status.exhibition.status !== expectedStatus) return false;
  if (currentPath !== originPath) return false;
  return true;
}
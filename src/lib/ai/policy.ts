import type { DatabaseSync } from "node:sqlite";
import { getExhibition } from "../db/repos";
import { getCurationWorkflow } from "../db/curationJobs";
import { getPhoto, listPhotos } from "../db/photos";
import { AiError, AiStaleContextError, AiUnauthorizedError, type AiErrorClass } from "./errors";
import type { AiPurpose, AiScopeType } from "./records";

/**
 * 外发授权策略（任务书 v3 §4.3 / §8.2）：统一外发入口每次执行前检查。
 * - connection_test：作者显式触发、固定无私密内容、独立频率（预算层限流），
 *   客户端禁止通过自填 purpose=connection_test 绕过业务授权；
 * - 业务调用：最新库内 mode=ai + allow_external_ai + 影展归属，重试/内部阶段/直接调 API 都不能绕过。
 * 这里只做授权判定；预算、并发与重试由 budget/client 承担。
 */

export interface AiCallContext {
  purpose: AiPurpose;
  scopeType: AiScopeType;
  scopeId: string;
  exhibitionId: string | null;
  agentType?: string | null;
  workflowId?: string | null;
  promptVersion: string;
  schemaVersion: string;
  preprocessVersion?: string | null;
  /** 单图校验只用于当前权限，不进入视觉缓存键。 */
  photoId?: string;
  photoSha256?: string;
  /** 同步重核当前任务 run/lease/冻结输入；不得在回调里启动异步检查。 */
  assertActive?: () => void;
}

/** 服务端模块守卫：AI 模块禁止进入浏览器打包链（任务书 §3.3）。 */
export function assertServerSide(): void {
  if (typeof window !== "undefined") {
    throw new Error("AI 模型客户端只能在服务端运行。");
  }
}

/** 每次外发前调用；对同一影展的重复调用会重新读取最新授权（撤销后立即生效）。 */
export function assertExternalSendAllowed(
  db: DatabaseSync,
  context: AiCallContext,
): void {
  assertServerSide();
  try {
    const checked: unknown = context.assertActive?.();
    if (checked && typeof (checked as Promise<unknown>).then === "function") {
      // 防止调用者误传 async 回调后检查尚未完成就发送。
      void Promise.resolve(checked).catch(() => {});
      throw new AiStaleContextError();
    }
  } catch (error) {
    if (error instanceof AiError) throw error;
    throw new AiStaleContextError();
  }

  if (context.purpose === "connection_test") {
    // 连接测试上下文由服务端受保护入口创建（阶段 F 实现端点）；此处仅接受合法 scope。
    if (context.scopeType !== "connection_test" || context.exhibitionId !== null) {
      throw new AiUnauthorizedError("连接测试上下文非法，已拒绝。");
    }
    return;
  }

  const exhibitionId = context.exhibitionId;
  if (!exhibitionId) {
    throw new AiUnauthorizedError("缺少影展归属，拒绝向外部模型发送数据。");
  }
  const exh = getExhibition(db, exhibitionId);
  if (!exh) {
    throw new AiUnauthorizedError("影展不存在或已删除，拒绝外发。");
  }
  if (exh.mode !== "ai") {
    throw new AiUnauthorizedError("该影展未启用 AI 模式，拒绝向外部模型发送数据。演示模式不受影响。");
  }
  if (!exh.allow_external_ai) {
    throw new AiUnauthorizedError(
      "尚未授权把压缩分析图与必要文字发送给已配置的模型服务。请先在创建页或素材页显式授权；演示模式不受影响。",
    );
  }
  if (context.photoId) {
    const photo = getPhoto(db, context.photoId);
    if (!photo || photo.exhibition_id !== exhibitionId ||
      (context.photoSha256 !== undefined && photo.sha256 !== context.photoSha256)) {
      throw new AiUnauthorizedError("照片不存在、归属不符或内容已变化，已拒绝使用旧输入及缓存。");
    }
  }
  const workflowId = context.workflowId ?? (context.scopeType === "workflow" ? context.scopeId : null);
  const workflow = workflowId ? getCurationWorkflow(db, workflowId) : null;
  if (workflow) {
    const photos = listPhotos(db, exhibitionId);
    const frozenIds = new Set(workflow.photo_ids);
    if (workflow.exhibition_id !== exhibitionId || workflow.input_revision !== exh.input_revision ||
      photos.length !== frozenIds.size || photos.some(p => !frozenIds.has(p.id))) {
      throw new AiUnauthorizedError("策展输入范围或版本已变化，旧工作流不能继续外发。请重新分析并确认范围；任务总额度不会重置。");
    }
  }
}

/** 仅用于状态展示：错误分类是否属于“未授权”。 */
export function isUnauthorizedClass(cls: AiErrorClass | null | undefined): boolean {
  return cls === "unauthorized" || cls === "auth";
}

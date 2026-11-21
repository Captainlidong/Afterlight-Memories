import type { DatabaseSync } from "node:sqlite";
import { isRunning } from "./orchestrator";
import { ConcurrentRunError } from "../api/errors";

/**
 * R07：活跃生成期间拒绝影响输入的写操作（读取/预览/放映不受限）。
 * 统一入口，避免只保护批量接口而单张/主题/文案/回滚仍可并发改数据。
 */
export function assertWritable(db: DatabaseSync, exhibitionId: string): void {
  if (isRunning(db, exhibitionId)) {
    throw new ConcurrentRunError("影展正在生成中，暂不能修改输入；请等待当前任务完成后再试。");
  }
}

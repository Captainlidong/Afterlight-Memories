import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { migrate } from "./migrations";
import { recoverOrphanedTasks } from "../orchestrator/recovery";
import { releaseStaleAiReservations } from "../ai/budget";

/** 运行时数据目录（SQLite + uploads），相对项目根解析。 */
export function dataDir(): string {
  const dir = process.env.AFTERLIGHT_DATA_DIR || "./data";
  return path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir);
}

/**
 * 打开（或创建）数据库并跑迁移。测试可传 ":memory:"。
 * 包在此处以便日后替换驱动（node:sqlite → better-sqlite3 等）。
 */
export function createDb(filename: string): DatabaseSync {
  if (filename !== ":memory:") {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  }
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode=WAL;");
  migrate(db);
  // 启动恢复（R03）：回收已失活/过期租约，避免上次崩溃的 running 行永久卡死。
  recoverOrphanedTasks(db, { includeUnleasedRuns: true });
  // 启动恢复（v3 §7.3）：归还进程中断前「已预留未发出」的模型调用名额。
  releaseStaleAiReservations(db);
  return db;
}

// Next dev 热重载会重复执行模块；缓存单连接避免 SQLITE_BUSY 与连接泄漏。
const globalForDb = globalThis as unknown as { __afterlightDb?: DatabaseSync };

export function getDb(): DatabaseSync {
  if (!globalForDb.__afterlightDb) {
    globalForDb.__afterlightDb = createDb(path.join(dataDir(), "afterlight.db"));
  }
  return globalForDb.__afterlightDb;
}

export function dbHealth(db: DatabaseSync): boolean {
  const r = db.prepare("SELECT 1 AS ok").get() as { ok: number } | undefined;
  return r?.ok === 1;
}
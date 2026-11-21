import path from "node:path";
import { dataDir } from "./db/client";

/** 上传目录绝对路径。原图绝不落在 public/ 下（§17.1）。 */
export function uploadsDir(exhibitionId: string): string {
  return path.join(dataDir(), "uploads", exhibitionId);
}

/** DB 中存储相对 POSIX 路径；读时转绝对。文件按 photo id 命名，用户文件名不落盘。 */
export function toRelative(absolutePath: string): string {
  return path.relative(dataDir(), absolutePath).split(path.sep).join("/");
}

export function toAbsolute(relativePath: string): string {
  return path.join(dataDir(), ...relativePath.split("/"));
}
"use client";

import { Button } from "./ui";

/** 网络/服务加载失败横幅（§19.1 F）：与「业务空态」严格区分，提供重试。 */
export function LoadError({ message, onRetry }: { message?: string; onRetry: () => void }) {
  return (
    <div className="card flex flex-wrap items-center gap-3 border-error/40 px-4 py-3 text-sm text-error">
      <span>{message ?? "加载失败，请检查网络后重试。"}</span>
      <Button variant="outline" className="ml-auto !py-1.5 text-xs" onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}
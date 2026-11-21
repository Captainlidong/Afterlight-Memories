"use client";

import { useCallback, useRef } from "react";

export type PendingSaver = () => Promise<boolean>;

/**
 * 离页保存屏障（v3 R02）：正在编辑的字段把「保存草稿」注册进来，
 * 下一步等动作先逐个等待保存成功；任一失败则不导航，草稿留在编辑框。
 */
export function useSaveBarrier(): {
  register: (save: PendingSaver) => () => void;
  flush: () => Promise<boolean>;
} {
  const pending = useRef(new Set<PendingSaver>());

  const register = useCallback((save: PendingSaver) => {
    pending.current.add(save);
    return () => {
      pending.current.delete(save);
    };
  }, []);

  const flush = useCallback(async () => {
    for (const save of Array.from(pending.current)) {
      if (!(await save())) return false;
    }
    return true;
  }, []);

  return { register, flush };
}

"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { consumeLandingFocus } from "./landingFocus";

/**
 * 自动跳转落地页：聚焦 h1 + 温和 aria-live 播报，只消费一次（§19.2(10)）。
 * 返回元组让调用方拿到独立的 ref 与消息，避免把含 ref 的对象整体带进渲染。
 */
export function useLandingFocus(
  exhibitionId: string,
  label: string,
): readonly [RefObject<HTMLHeadingElement | null>, string | null] {
  const ref = useRef<HTMLHeadingElement>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (consumeLandingFocus(sessionStorage, exhibitionId)) {
      ref.current?.focus();
      queueMicrotask(() => setMessage(`已进入${label}`));
    }
  }, [exhibitionId, label]);

  return [ref, message] as const;
}

import type { ReactNode } from "react";

/**
 * 滚动揭示容器（纯标记，无 hook）：浏览页 BrowseView 统一用 IntersectionObserver 加 .is-visible；
 * 静态导出无 JS，由导出 CSS 强制可见。保持无 hook 以便服务端 renderToStaticMarkup 复用。
 */
export function Reveal({ children, className = "", id }: { children: ReactNode; className?: string; id?: string }) {
  return (
    <div id={id} className={`reveal ${className}`}>
      {children}
    </div>
  );
}
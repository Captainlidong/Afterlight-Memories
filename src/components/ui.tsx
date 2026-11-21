import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "outline" | "ghost";

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button className={`btn btn-${variant} ${className}`} {...props} />;
}

export function Badge({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "ok" | "warn" | "error" | "gold";
}) {
  const color =
    tone === "ok"
      ? "text-ok border-ok/40"
      : tone === "warn"
        ? "text-warn border-warn/40"
        : tone === "error"
          ? "text-error border-error/40"
          : tone === "gold"
            ? "text-gold border-gold/40"
            : "text-muted border-ink-line";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs ${color}`}
    >
      {children}
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-muted text-sm">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-ink-line border-t-gold" />
      {label}
    </span>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="card flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div className="font-display text-xl text-text">{title}</div>
      {description && (
        <p className="max-w-md text-sm leading-relaxed text-muted">{description}</p>
      )}
      {action}
    </div>
  );
}
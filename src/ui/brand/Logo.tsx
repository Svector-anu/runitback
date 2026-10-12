import type { ReactNode } from "react";

export type LogoVariant = "mark" | "lockup";

interface LogoProps {
  variant?: LogoVariant;
  /** Mark edge length in px; the lockup wordmark scales with it. */
  size?: number;
  className?: string;
}

/**
 * RunItBack mark: a play triangle inside a replay loop on a rounded tile. Monochrome: the tile takes
 * `currentColor`, the glyph takes `--logo-ink` (defaults to the page background), so it works on any
 * surface in both themes. Geometry is duplicated in public/favicon.svg; keep both in sync.
 */
function Mark({ size }: { size: number }): ReactNode {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="9" fill="currentColor" />
      <g fill="var(--logo-ink, var(--background))" stroke="var(--logo-ink, var(--background))" strokeLinejoin="round">
        <path d="M10.54 9.49A8.5 8.5 0 1 1 8.01 18.91" fill="none" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M8.09 11.55 8.87 7.5 12.2 11.5Z" strokeWidth="1.2" />
        <path d="M13.6 12.6v6.8l5.9-3.4Z" strokeWidth="1.2" />
      </g>
    </svg>
  );
}

export function Logo({ variant = "mark", size = 20, className }: LogoProps): ReactNode {
  if (variant === "mark") return <Mark size={size} />;
  return (
    <span className={["brand-lockup", className].filter(Boolean).join(" ")} style={{ fontSize: Math.round(size * 0.82) }}>
      <Mark size={size} />
      <span className="brand-lockup__word">RunItBack</span>
    </span>
  );
}

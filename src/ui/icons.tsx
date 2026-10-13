import type { ReactNode, SVGProps } from "react";

const p = (d: string, key?: string): ReactNode => <path key={key ?? d} d={d} />;
const line = (x1: number, y1: number, x2: number, y2: number): ReactNode => <line key={`${x1}${y1}${x2}${y2}`} x1={x1} y1={y1} x2={x2} y2={y2} />;

const ICONS = {
  play: <polygon points="6 3 20 12 6 21 6 3" fill="currentColor" />,
  pause: <><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" /><rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" /></>,
  scissors: <><circle cx="6" cy="6" r="3" />{p("M8.12 8.12 12 12")}{p("M20 4 8.12 15.88")}<circle cx="6" cy="18" r="3" />{p("M14.8 14.8 20 20")}</>,
  "split-left": <>{p("M12 3v18")}{p("M3 8h6M3 12h6M3 16h6")}{p("M15 8l6 8M21 8l-6 8")}</>,
  "split-right": <>{p("M12 3v18")}{p("M15 8h6M15 12h6M15 16h6")}{p("M3 8l6 8M9 8l-6 8")}</>,
  copy: <><rect width="14" height="14" x="8" y="8" rx="2" ry="2" />{p("M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2")}</>,
  trash: <>{p("M3 6h18")}{p("M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6")}{p("M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2")}</>,
  bookmark: p("m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"),
  magnet: <>{p("m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15")}{p("m5 8 4 4")}{p("m12 15 4 4")}</>,
  beat: <>{p("M2 12h3l2-6 4 12 3-9 2 3h6")}</>,
  "beat-ticks": <>{line(4, 18, 20, 18)}{line(6, 18, 6, 14)}{line(12, 18, 12, 10)}{line(18, 18, 18, 14)}</>,
  ripple: <>{p("M2 8c2-3 4-3 6 0s4 3 6 0 4-3 8 0")}{p("M2 14c2-3 4-3 6 0s4 3 6 0 4-3 8 0")}{p("M2 20c2-3 4-3 6 0s4 3 6 0 4-3 8 0")}</>,
  "zoom-in": <><circle cx="11" cy="11" r="8" />{p("m21 21-4.3-4.3")}{p("M11 8v6")}{p("M8 11h6")}</>,
  "zoom-out": <><circle cx="11" cy="11" r="8" />{p("m21 21-4.3-4.3")}{p("M8 11h6")}</>,
  search: <><circle cx="11" cy="11" r="8" />{p("m21 21-4.3-4.3")}</>,
  volume: <><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />{p("M15.54 8.46a5 5 0 0 1 0 7.07")}{p("M19.07 4.93a10 10 0 0 1 0 14.14")}</>,
  "volume-off": <><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />{line(22, 9, 16, 15)}{line(16, 9, 22, 15)}</>,
  eye: <>{p("M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z")}<circle cx="12" cy="12" r="3" /></>,
  "eye-off": <>{p("M9.88 9.88a3 3 0 1 0 4.24 4.24")}{p("M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68")}{p("M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61")}{line(2, 2, 22, 22)}</>,
  video: <>{p("m22 8-6 4 6 4V8Z")}<rect width="14" height="12" x="2" y="6" rx="2" ry="2" /></>,
  music: <>{p("M9 18V5l12-2v13")}<circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>,
  image: <><rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><circle cx="9" cy="9" r="2" />{p("m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21")}</>,
  type: <><polyline points="4 7 4 4 20 4 20 7" />{line(9, 20, 15, 20)}{line(12, 4, 12, 20)}</>,
  shapes: <>{p("M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z")}<rect x="3" y="14" width="7" height="7" rx="1" /><circle cx="17.5" cy="17.5" r="3.5" /></>,
  wand: <>{p("m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72Z")}{p("m14 7 3 3")}{p("M5 6v4")}{p("M19 14v4")}{p("M10 2v2")}{p("M7 8H3")}{p("M21 16h-4")}{p("M11 3H9")}</>,
  crosshair: <><circle cx="12" cy="12" r="9" />{line(22, 12, 18, 12)}{line(6, 12, 2, 12)}{line(12, 6, 12, 2)}{line(12, 22, 12, 18)}</>,
  pipette: <>{p("m2 22 1-1h3l9-9")}{p("M3 21v-3l9-9")}{p("m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z")}</>,
  folder: p("M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"),
  captions: <><rect width="18" height="14" x="3" y="5" rx="2" ry="2" />{p("M7 15h4M15 15h2M7 11h2M13 11h4")}</>,
  sliders: <>{line(21, 4, 14, 4)}{line(10, 4, 3, 4)}{line(21, 12, 12, 12)}{line(8, 12, 3, 12)}{line(21, 20, 16, 20)}{line(12, 20, 3, 20)}{line(14, 2, 14, 6)}{line(8, 10, 8, 14)}{line(16, 18, 16, 22)}</>,
  plus: <>{p("M5 12h14")}{p("M12 5v14")}</>,
  x: <>{p("M18 6 6 18")}{p("m6 6 12 12")}</>,
  check: p("M20 6 9 17l-5-5"),
  "chevron-down": p("m6 9 6 6 6-6"),
  "chevron-right": p("m9 18 6-6-6-6"),
  "arrow-right": <>{p("M5 12h14")}{p("m12 5 7 7-7 7")}</>,
  "arrow-left": <>{p("m12 19-7-7 7-7")}{p("M19 12H5")}</>,
  "arrow-down": <>{p("M12 5v14")}{p("m19 12-7 7-7-7")}</>,
  upload: <>{p("M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4")}<polyline points="17 8 12 3 7 8" />{line(12, 3, 12, 15)}</>,
  download: <>{p("M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4")}<polyline points="7 10 12 15 17 10" />{line(12, 15, 12, 3)}</>,
  grid: <><rect width="7" height="7" x="3" y="3" rx="1" /><rect width="7" height="7" x="14" y="3" rx="1" /><rect width="7" height="7" x="14" y="14" rx="1" /><rect width="7" height="7" x="3" y="14" rx="1" /></>,
  list: <>{line(8, 6, 21, 6)}{line(8, 12, 21, 12)}{line(8, 18, 21, 18)}{line(3, 6, 3.01, 6)}{line(3, 12, 3.01, 12)}{line(3, 18, 3.01, 18)}</>,
  more: <><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></>,
  sun: <><circle cx="12" cy="12" r="4" />{p("M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41")}</>,
  moon: p("M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"),
  reset: <>{p("M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8")}{p("M3 3v5h5")}</>,
  rotate: <>{p("M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8")}{p("M21 3v5h-5")}</>,
  link: <>{p("M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71")}{p("M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71")}</>,
  unlink: <>{p("m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71")}{p("m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71")}{line(8, 2, 8, 5)}{line(2, 8, 5, 8)}{line(16, 19, 16, 22)}{line(19, 16, 22, 16)}</>,
  layers: <>{p("m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z")}{p("m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65")}{p("m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65")}</>,
  undo: <>{p("M3 7v6h6")}{p("M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13")}</>,
  redo: <>{p("M21 7v6h-6")}{p("M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7")}</>,
  fullscreen: <>{p("M8 3H5a2 2 0 0 0-2 2v3")}{p("M21 8V5a2 2 0 0 0-2-2h-3")}{p("M3 16v3a2 2 0 0 0 2 2h3")}{p("M16 21h3a2 2 0 0 0 2-2v-3")}</>,
  keyframe: p("M12 2.5 21.5 12 12 21.5 2.5 12Z"),
  pointer: p("M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"),
  "app-window": <><rect x="2" y="4" width="20" height="16" rx="2" />{p("M10 4v4")}{p("M2 8h20")}{p("M6 4v4")}</>,
  gauge: <>{p("m12 14 4-4")}{p("M3.34 19a10 10 0 1 1 17.32 0")}</>,
  move: <>{p("M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20")}</>,
  droplet: p("M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"),
  command: p("M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"),
  "log-out": <>{p("M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4")}<polyline points="16 17 21 12 16 7" />{line(21, 12, 9, 12)}</>,
  info: <><circle cx="12" cy="12" r="10" />{p("M12 16v-4")}{p("M12 8h.01")}</>,
  edit: p("M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"),
  alert: <><circle cx="12" cy="12" r="10" />{line(12, 8, 12, 12)}{line(12, 16, 12.01, 16)}</>,
  loader: p("M21 12a9 9 0 1 1-6.219-8.56"),
  calendar: <><rect width="18" height="18" x="3" y="4" rx="2" ry="2" />{line(16, 2, 16, 6)}{line(8, 2, 8, 6)}{line(3, 10, 21, 10)}</>,
  film: <><rect width="18" height="18" x="3" y="3" rx="2" />{p("M7 3v18M3 7.5h4M3 12h18M3 16.5h4M17 3v18M17 7.5h4M17 16.5h4")}</>,
  star: p("M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"),
  square: <rect width="18" height="18" x="3" y="3" rx="2" />,
  circle: <circle cx="12" cy="12" r="10" />,
  polygon: <polygon points="12 2 21 8.5 17.5 19 6.5 19 3 8.5" />,
  freeze: <>{line(12, 2, 12, 22)}{line(4.93, 4.93, 19.07, 19.07)}{line(2, 12, 22, 12)}{line(19.07, 4.93, 4.93, 19.07)}</>,
  user: <>{p("M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2")}<circle cx="12" cy="7" r="4" /></>,
  "arrow-up-down": <>{p("m21 16-4 4-4-4M17 20V4M3 8l4-4 4 4M7 4v16")}</>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size, ...rest }: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, "name">): ReactNode {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" width={size ?? 16} height={size ?? 16} aria-hidden="true" focusable="false" {...rest}
    >
      {ICONS[name]}
    </svg>
  );
}

export function Logo({ size = 20 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="currentColor" />
      <path d="M11 9.5v13l11-6.5z" fill="var(--background)" />
    </svg>
  );
}

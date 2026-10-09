import type { ReactNode } from 'react';

/**
 * Inline SVG icon set on a 16px grid, 1.5px strokes, drawn in `currentColor`. Icons are decorative by default
 * (`aria-hidden`); pass `title` only when the icon is the sole carrier of meaning.
 */
export type IconName =
  // navigation
  | 'tower'
  | 'console'
  | 'projects'
  | 'decisions'
  | 'changes'
  | 'rollbacks'
  | 'registry'
  | 'metering'
  | 'credits'
  | 'learning'
  | 'knowledge'
  | 'audit'
  | 'compliance'
  | 'tickets'
  | 'admin'
  | 'showcase'
  // liveness
  | 'working'
  | 'thinking'
  | 'stalled'
  | 'dead'
  | 'throttled'
  | 'waiting'
  | 'ended'
  | 'retired'
  // controls & status
  | 'menu'
  | 'close'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-down'
  | 'chevron-up'
  | 'sort-asc'
  | 'sort-desc'
  | 'sort-none'
  | 'info'
  | 'warn'
  | 'danger'
  | 'ok'
  | 'copy'
  | 'check'
  | 'clock'
  | 'inbox'
  | 'user'
  | 'external'
  | 'search'
  | 'plus'
  | 'minus'
  | 'arrow-up'
  | 'arrow-down'
  | 'sign-out'
  | 'sidebar-collapse'
  | 'sidebar-expand'
  | 'filter'
  | 'retry'
  | 'eye'
  | 'eye-off'
  | 'upload'
  | 'key'
  | 'table'
  | 'dot';

const dot = (cx: number, cy: number, r = 0.9) => (
  <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />
);

const PATHS: Record<IconName, ReactNode> = {
  tower: (
    <>
      <path d="M4.25 2.75h7.5L10.5 6h-5zM6.5 6v7.75M9.5 6v7.75M4.5 13.75h7M6.5 9.5h3" />
      <path d="M8 2.75V1.5" />
    </>
  ),
  console: (
    <>
      <rect x="2" y="2.75" width="12" height="8.5" rx="1.5" />
      <path d="M5.5 13.5h5M4.5 7.25h1.5l1-2 1.75 4 1-2h1.75" />
    </>
  ),
  projects: <path d="M8 2.5l5.5 3-5.5 3-5.5-3zM2.5 8.25l5.5 3 5.5-3M2.5 10.75l5.5 3 5.5-3" />,
  decisions: (
    <>
      <path d="M8 2.25L13.75 8 8 13.75 2.25 8z" />
      <path d="M8 5.75v2.75" />
      {dot(8, 10.4, 0.8)}
    </>
  ),
  changes: (
    <>
      <circle cx="4.5" cy="3.75" r="1.5" />
      <circle cx="4.5" cy="12.25" r="1.5" />
      <circle cx="11.5" cy="12.25" r="1.5" />
      <path d="M4.5 5.25v5.5M11.5 10.75V7.5a2 2 0 0 0-2-2H7.25M8.75 4L7.25 5.5 8.75 7" />
    </>
  ),
  rollbacks: <path d="M2.75 4.25v3h3M3.3 7.25A5 5 0 1 1 4.6 11.7" />,
  registry: (
    <>
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
    </>
  ),
  metering: <path d="M3 13.5V9M6.5 13.5V5M10 13.5V7.5M13.5 13.5V2.5" />,
  credits: (
    <>
      <ellipse cx="8" cy="4.5" rx="5" ry="2" />
      <path d="M3 4.5V8c0 1.1 2.24 2 5 2s5-.9 5-2V4.5M3 8v3.5c0 1.1 2.24 2 5 2s5-.9 5-2V8" />
    </>
  ),
  learning: (
    <path d="M6 13.75h4M6.25 11.75h3.5M8 2.25a4 4 0 0 0-2.4 7.2c.35.27.5.68.5 1.12v1.18h3.8v-1.18c0-.44.15-.85.5-1.12A4 4 0 0 0 8 2.25z" />
  ),
  knowledge: (
    <path d="M8 4.25C6.5 3.25 4.5 2.75 2.5 2.75v10c2 0 4 .5 5.5 1.5 1.5-1 3.5-1.5 5.5-1.5v-10c-2 0-4 .5-5.5 1.5zM8 4.25v10" />
  ),
  audit: (
    <>
      <path d="M4 2.5h5l3 3v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1zM9 2.5v3h3" />
      <path d="M5.5 9.75l1.5 1.5 3-3" />
    </>
  ),
  compliance: (
    <path d="M8 1.75l5 2v4.1c0 3-2.15 5.25-5 6.15-2.85-.9-5-3.15-5-6.15v-4.1zM5.75 8.1l1.5 1.5 3-3" />
  ),
  tickets: (
    <path d="M2.5 5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1.5a1.5 1.5 0 0 0 0 3V11a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V9.5a1.5 1.5 0 0 0 0-3zM9.75 4.5v1.25M9.75 7.4v1.2M9.75 10.25v1.25" />
  ),
  admin: (
    <>
      <circle cx="6" cy="5.5" r="2.25" />
      <path d="M2 13.25c.6-2 2.1-3 4-3s3.4 1 4 3M10.25 3.6a2 2 0 0 1 0 3.8M11.25 10.1c1.4.25 2.35 1.1 2.75 2.65" />
    </>
  ),
  showcase: <path d="M8 1.75l5.5 3.1v6.3L8 14.25l-5.5-3.1v-6.3zM2.5 4.85L8 8l5.5-3.15M8 8v6.25" />,

  working: <path d="M1.5 8.25h2.75l1.75-4.5 3 8.5 1.75-4h3.75" />,
  thinking: (
    <>
      {dot(3.75, 8, 1.15)}
      {dot(8, 8, 1.15)}
      {dot(12.25, 8, 1.15)}
    </>
  ),
  stalled: (
    <>
      <path d="M7.13 2.75a1 1 0 0 1 1.74 0l5.2 9.25a1 1 0 0 1-.87 1.5H2.8a1 1 0 0 1-.87-1.5z" />
      <path d="M8 6.5v2.75" />
      {dot(8, 11.1, 0.8)}
    </>
  ),
  dead: (
    <>
      <path d="M5.4 1.9h5.2l3.5 3.5v5.2l-3.5 3.5H5.4l-3.5-3.5V5.4z" />
      <path d="M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2" />
    </>
  ),
  throttled: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.75V8l2.25 1.5" />
    </>
  ),
  waiting: (
    <>
      <path d="M8 2.25L13.75 8 8 13.75 2.25 8z" />
      {dot(8, 8, 1.6)}
    </>
  ),
  ended: <rect x="3.75" y="3.75" width="8.5" height="8.5" rx="1.5" />,
  retired: <path d="M2.5 3h11v3h-11zM3.5 6v6.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V6M6.5 8.75h3" />,

  menu: <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  'chevron-left': <path d="M10 3.5L5.5 8l4.5 4.5" />,
  'chevron-right': <path d="M6 3.5L10.5 8 6 12.5" />,
  'chevron-down': <path d="M3.5 6L8 10.5 12.5 6" />,
  'chevron-up': <path d="M3.5 10L8 5.5 12.5 10" />,
  'sort-asc': <path d="M8 12.5v-9M4.75 6.75L8 3.5l3.25 3.25" />,
  'sort-desc': <path d="M8 3.5v9M4.75 9.25L8 12.5l3.25-3.25" />,
  'sort-none': <path d="M5.25 6.25L8 3.5l2.75 2.75M5.25 9.75L8 12.5l2.75-2.75" />,
  info: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.25v4" />
      {dot(8, 5, 0.85)}
    </>
  ),
  warn: (
    <>
      <path d="M7.13 2.75a1 1 0 0 1 1.74 0l5.2 9.25a1 1 0 0 1-.87 1.5H2.8a1 1 0 0 1-.87-1.5z" />
      <path d="M8 6.5v2.75" />
      {dot(8, 11.1, 0.8)}
    </>
  ),
  danger: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.75v3.75" />
      {dot(8, 10.9, 0.85)}
    </>
  ),
  ok: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M5.25 8.25l1.9 1.9 3.6-3.9" />
    </>
  ),
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </>
  ),
  check: <path d="M3 8.5l3 3 7-7" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.75V8l2.25 1.5" />
    </>
  ),
  inbox: (
    <path d="M2.5 9.25h3.25l1 1.5h2.5l1-1.5h3.25M2.5 9.25l1.55-4.9a1 1 0 0 1 .95-.7h6a1 1 0 0 1 .95.7l1.55 4.9v3.25a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />
  ),
  user: (
    <>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 13.5c.8-2.4 2.8-3.5 5-3.5s4.2 1.1 5 3.5" />
    </>
  ),
  external: (
    <path d="M9 2.5h4.5V7M13.5 2.5l-6 6M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.25 10.25l3.25 3.25" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  minus: <path d="M3 8h10" />,
  'arrow-up': <path d="M8 12.5v-9M4.5 7L8 3.5 11.5 7" />,
  'arrow-down': <path d="M8 3.5v9M4.5 9L8 12.5 11.5 9" />,
  'sign-out': <path d="M6 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1H6M10.5 11l3-3-3-3M13.5 8h-7" />,
  'sidebar-collapse': (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M6 2.5v11M11 6l-2 2 2 2" />
    </>
  ),
  'sidebar-expand': (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M6 2.5v11M9 6l2 2-2 2" />
    </>
  ),
  filter: <path d="M2.5 3.5h11l-4.25 5v4l-2.5 1v-5z" />,
  retry: <path d="M13.25 4.5v3h-3M12.7 7.5A5 5 0 1 0 11.4 11.7" />,
  eye: (
    <>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  'eye-off': (
    <>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
      <path d="M2.5 2.5l11 11" />
    </>
  ),
  upload: <path d="M8 10.5v-8M4.75 5.75L8 2.5l3.25 3.25M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2" />,
  key: (
    <>
      <circle cx="5" cy="11" r="2.5" />
      <path d="M6.8 9.2l6.7-6.7M11.25 4.75l1.75 1.75M9.5 6.5l1.25 1.25" />
    </>
  ),
  table: <path d="M2.5 3.5h11v9h-11zM2.5 6.5h11M2.5 9.5h11M6.5 6.5v6" />,
  dot: <circle cx="8" cy="8" r="3.5" fill="currentColor" stroke="none" />,
};

export interface IconProps {
  /** Which glyph to draw. */
  name: IconName;
  /** Rendered size in px (square). Default 16. */
  size?: number;
  /** Accessible label; when omitted the icon is hidden from assistive tech. */
  title?: string;
  className?: string;
}

export function Icon({ name, size = 16, title, className }: IconProps) {
  const a11y = title
    ? ({ role: 'img', 'aria-label': title } as const)
    : ({ 'aria-hidden': true, focusable: 'false' } as const);
  return (
    <svg
      className={className ? `aoc-icon ${className}` : 'aoc-icon'}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      data-icon={name}
      {...a11y}
    >
      {PATHS[name]}
    </svg>
  );
}

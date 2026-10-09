import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { cx } from '../lib/dom';
import type { SegmentTone } from './types';

/**
 * Width of an element, tracked with ResizeObserver. Returns a callback ref and the width; `fallback` is
 * used until the first measurement (and in environments without layout, such as tests).
 */
export function useElementWidth<T extends HTMLElement>(fallback = 320): [(el: T | null) => void, number] {
  const [width, setWidth] = useState(fallback);
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const measure = (w: number) => {
      const next = Math.floor(w);
      if (next > 0) setWidth((prev) => (prev === next ? prev : next));
    };
    measure(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    observer.current = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) measure(entry.contentRect.width);
    });
    observer.current.observe(el);
  }, []);

  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, width];
}

const TONE_VAR: Record<SegmentTone, string> = {
  'series-1': 'var(--series-1)',
  'series-2': 'var(--series-2)',
  'series-3': 'var(--series-3)',
  'series-4': 'var(--series-4)',
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  danger: 'var(--danger)',
  info: 'var(--info)',
  neutral: 'var(--mark-tool)',
};

/** CSS colour for a segment tone. */
export function toneColor(tone: SegmentTone): string {
  return TONE_VAR[tone];
}

/**
 * Categorical slots in fixed order. The kit caps categorical identity at four adjacent hues: the token
 * palette validates for four adjacent slots in both themes; a fifth series folds into "Other".
 */
export const CATEGORICAL: readonly SegmentTone[] = ['series-1', 'series-2', 'series-3', 'series-4'];

/** Rough rendered width of `text` at `fontPx` in the UI sans (good enough to decide whether a label fits). */
export function estimateTextWidth(text: string, fontPx = 12): number {
  return text.length * fontPx * 0.56;
}

/** Path for a vertical bar with rounded top corners and a square baseline (dataviz mark spec). */
export function columnPath(x: number, y: number, w: number, h: number, radius = 4): string {
  if (h <= 0 || w <= 0) return '';
  const r = Math.min(radius, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** Path for a horizontal bar with a rounded right end and a square start. */
export function barPath(x: number, y: number, w: number, h: number, radius = 4): string {
  if (h <= 0 || w <= 0) return '';
  const r = Math.min(radius, h / 2, w);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

export interface HitItem {
  key: string;
  /** Box in the plot's pixel coordinates (the SVG is drawn 1:1 in px). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Accessible name announced on focus: the full value, e.g. "Decision: Approve migration, 14:05". */
  label: string;
  /** Visual tooltip (hover and focus). Enhances only — the value also exists as text. */
  tooltip: ReactNode;
  onActivate?: () => void;
}

export interface HitLayerProps {
  items: readonly HitItem[];
  /** Name of the group ("Timeline marks"). */
  label: string;
  /** Plot size, for keeping the tooltip inside. */
  width: number;
  height: number;
  /** Minimum hit-target edge in px (dataviz: ≥ 24). */
  minSize?: number;
}

/**
 * Transparent, keyboard-focusable targets over chart marks. One tab stop (roving tabindex): ←/→ move,
 * Home/End jump, Enter activates, Escape hides the tooltip. The same tooltip shows on hover and focus.
 */
export function HitLayer({ items, label, width, height, minSize = 24 }: HitLayerProps) {
  const [active, setActive] = useState(0);
  const [shown, setShown] = useState<number | null>(null);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const tipRef = useRef<HTMLDivElement>(null);
  const [tipPos, setTipPos] = useState<CSSProperties>({ visibility: 'hidden' });

  const current = shown !== null ? items[shown] : undefined;
  const cx0 = current?.x;
  const cy0 = current?.y;
  const cw = current?.width;
  const ch = current?.height;

  // Measure the rendered tooltip, then keep it inside the plot (above the mark, flipping below if needed).
  useLayoutEffect(() => {
    if (cx0 === undefined || cy0 === undefined || cw === undefined || ch === undefined || !tipRef.current) {
      setTipPos((p) => (p.visibility === 'hidden' ? p : { visibility: 'hidden' }));
      return;
    }
    const tw = tipRef.current.offsetWidth;
    const th = tipRef.current.offsetHeight;
    const left = Math.round(Math.max(0, Math.min(cx0 + cw / 2 - tw / 2, width - tw)));
    const above = cy0 - th - 6;
    const top = Math.round(above >= -th / 2 ? above : cy0 + ch + 6);
    setTipPos((p) => (p.left === left && p.top === top && p.visibility === undefined ? p : { left, top }));
  }, [shown, cx0, cy0, cw, ch, width, height]);

  const safeActive = Math.min(active, Math.max(0, items.length - 1));

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (items.length === 0) return;
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = Math.min(items.length - 1, safeActive + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = Math.max(0, safeActive - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'Escape') {
      setShown(null);
      return;
    }
    if (next < 0) return;
    e.preventDefault();
    setActive(next);
    setShown(next);
    refs.current[next]?.focus();
  };

  if (items.length === 0) return null;
  return (
    <div className="aoc-hits" role="group" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((it, i) => {
        const w = Math.max(minSize, it.width);
        const h = Math.max(minSize, it.height);
        const style: CSSProperties = {
          left: it.x + it.width / 2 - w / 2,
          top: it.y + it.height / 2 - h / 2,
          width: w,
          height: h,
        };
        return (
          <button
            key={it.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            className={cx('aoc-hits__target', shown === i && 'is-active')}
            style={style}
            tabIndex={i === safeActive ? 0 : -1}
            aria-label={it.label}
            onFocus={() => {
              setActive(i);
              setShown(i);
            }}
            onBlur={() => setShown((s) => (s === i ? null : s))}
            onPointerEnter={() => setShown(i)}
            onPointerLeave={() => setShown((s) => (s === i ? null : s))}
            onClick={it.onActivate}
          />
        );
      })}
      {current && (
        <div ref={tipRef} className="aoc-chart-tip" style={tipPos} aria-hidden="true">
          {current.tooltip}
        </div>
      )}
    </div>
  );
}

export interface ChartTableProps {
  /** Disclosure label. Default "Data table". */
  summary?: string;
  caption: string;
  columns: readonly string[];
  rows: ReadonlyArray<readonly ReactNode[]>;
  /** Indexes of numeric columns (right-aligned, tabular). */
  numericColumns?: readonly number[];
}

/** Collapsible table twin of a chart — the WCAG-clean equivalent of every mark. */
export function ChartTable({
  summary = 'Data table',
  caption,
  columns,
  rows,
  numericColumns = [],
}: ChartTableProps) {
  return (
    <details className="aoc-chart-table">
      <summary>{summary}</summary>
      <div className="aoc-chart-table__scroll">
        <table>
          <caption className="aoc-sr-only">{caption}</caption>
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th
                  key={`${i}-${c}`}
                  scope="col"
                  className={numericColumns.includes(i) ? 'is-end' : undefined}
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((cell, ci) => (
                  <td key={ci} className={numericColumns.includes(ci) ? 'is-end aoc-num' : undefined}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

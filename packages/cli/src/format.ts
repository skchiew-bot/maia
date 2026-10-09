/** Terminal rendering: compact aligned tables, liveness badges (symbol + word, never colour alone), ASCII bars. */
import {
  LIVENESS_LABEL,
  LIVENESS_STATES,
  modelTierOf,
  type LivenessState,
  type ProgressDTO,
  type ProjectTimeline,
  type SessionLifecycle,
} from '@aoc/contracts';

// ── untrusted text ───────────────────────────────────────────────────────────
// Session titles, transcripts and tool output are untrusted: strip escape sequences and control
// characters so daemon-supplied text cannot rewrite the terminal (cursor moves, fake lines, OSC links).
const ESCAPE_SEQ =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[P^_][^\u001b]*(?:\u001b\\)?|[@-Z\\-_])/g;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function sanitize(text: string): string {
  return text.replace(ESCAPE_SEQ, '').replace(CONTROL, '');
}

/** Sanitized single-line cell text. */
export function oneLine(v: unknown): string {
  if (v === null || v === undefined) return '';
  return sanitize(String(v)).replace(/\s+/g, ' ').trim();
}

export function width(s: string): number {
  return [...s].length;
}

export function truncate(s: string, max: number): string {
  const cps = [...s];
  return cps.length <= max ? s : cps.slice(0, Math.max(0, max - 1)).join('') + '…';
}

// ── tables ───────────────────────────────────────────────────────────────────
export interface Column {
  header: string;
  align?: 'left' | 'right';
  /** Longer cells are truncated with an ellipsis. */
  max?: number;
}

export function renderTable(columns: Column[], rows: unknown[][]): string {
  const body = rows.map((r) =>
    columns.map((c, i) => truncate(oneLine(r[i]), c.max ?? Number.POSITIVE_INFINITY)),
  );
  const widths = columns.map((c, i) => Math.max(width(c.header), ...body.map((r) => width(r[i]!))));
  const line = (cells: string[]) =>
    cells
      .map((v, i) => {
        const pad = ' '.repeat(widths[i]! - width(v));
        return columns[i]!.align === 'right' ? pad + v : v + pad;
      })
      .join('  ')
      .trimEnd();
  return [line(columns.map((c) => c.header)), ...body.map(line)].join('\n');
}

/** Aligned "key  value" block. */
export function renderKv(pairs: [string, unknown][]): string {
  const shown = pairs.filter(([, v]) => v !== undefined);
  const w = Math.max(0, ...shown.map(([k]) => width(k)));
  return shown.map(([k, v]) => `${k.padEnd(w)}  ${oneLine(v) || '—'}`).join('\n');
}

// ── liveness ─────────────────────────────────────────────────────────────────
export const LIVENESS_SYMBOL: Record<LivenessState, string> = {
  waiting_on_you: '◆',
  throttled: '‖',
  dead: '✕',
  stalled: '■',
  thinking: '◌',
  working: '▶',
};

export function lifecycleLabel(lc: SessionLifecycle | string | null | undefined): string {
  if (!lc) return 'Unknown';
  const s = lc.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Symbol + word. A session that is no longer live (liveness null) shows its lifecycle instead. */
export function livenessBadge(
  state: LivenessState | null | undefined,
  lifecycle?: SessionLifecycle | string | null,
): string {
  if (state && state in LIVENESS_SYMBOL) return `${LIVENESS_SYMBOL[state]} ${LIVENESS_LABEL[state]}`;
  return `○ ${lifecycleLabel(lifecycle)}`;
}

/** Precedence rank for sorting (waiting on you first); not-live sessions sort last. */
export function livenessRank(state: LivenessState | null | undefined): number {
  return state ? LIVENESS_STATES.indexOf(state) : LIVENESS_STATES.length;
}

// ── numbers & time ───────────────────────────────────────────────────────────
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 10) return m % 60 ? `${h}h${String(m % 60).padStart(2, '0')}m` : `${h}h`;
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function formatAge(iso: string | null | undefined, now: number): string {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(t) ? '—' : formatDuration(now - t);
}

export function usd(n: number | null | undefined): string {
  return typeof n === 'number' ? `$${n.toFixed(2)}` : '—';
}

export function pct(n: number | null | undefined, digits = 0): string {
  return typeof n === 'number' ? `${n.toFixed(digits)}%` : '—';
}

export function int(n: number | null | undefined): string {
  return typeof n === 'number' ? n.toLocaleString('en-US') : '—';
}

export function tasksCell(p: Pick<ProgressDTO, 'doneTasks' | 'totalTasks'> | null | undefined): string {
  return p ? `${p.doneTasks}/${p.totalTasks}` : '—';
}

export function modelCell(model: string | null | undefined): string {
  if (!model) return '—';
  const tier = modelTierOf(model);
  return tier === 'unknown' ? model : tier;
}

// ── bars ─────────────────────────────────────────────────────────────────────
/** Split `width` cells across values proportionally (largest remainder), so segments always sum to `width`. */
export function apportion(values: number[], width: number): number[] {
  const total = values.reduce((a, b) => a + Math.max(0, b), 0);
  if (total <= 0 || width <= 0) return values.map(() => 0);
  const exact = values.map((v) => (Math.max(0, v) / total) * width);
  const out = exact.map(Math.floor);
  let rest = width - out.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => ({ i, r: e - out[i]! })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    out[i]!++;
    rest--;
  }
  return out;
}

export function bar(done: number, total: number, cells = 20): string {
  const filled = total > 0 ? Math.round((Math.min(Math.max(done, 0), total) / total) * cells) : 0;
  return `[${'#'.repeat(filled)}${'-'.repeat(cells - filled)}]`;
}

export function progressCell(p: ProgressDTO | null | undefined, cells = 10): string {
  if (!p) return '—';
  return `${bar(p.doneWeight, p.totalWeight, cells)} ${pct(p.pct, 1)}`;
}

const OWNER_GLYPHS = ['#', '=', '+', '*', '%', '@', '&', 'o', 'x', '~'];

function phaseLetter(i: number): string {
  return i < 26 ? String.fromCharCode(65 + i) : '?';
}

/**
 * Master timeline (§9) in ASCII: an overall bar stacked per phase (segment width ∝ phase weight, filled
 * with the phase letter as work is done), then one stacked bar per phase with a segment per contributor.
 * Every bar carries its numbers as text.
 */
export function renderTimeline(t: ProjectTimeline, cells = 40): string {
  const p = t.progress;
  const out = [
    `${oneLine(t.name)} (${t.projectId}) — ${pct(p.pct, 1)} done · ${p.doneWeight}/${p.totalWeight} weight · ${p.doneTasks}/${p.totalTasks} tasks`,
  ];
  const phases = [...t.phases].sort((a, b) => a.order - b.order);
  if (phases.length === 0) {
    out.push('No plan declared yet.');
    return out.join('\n');
  }

  const segWidths = apportion(
    phases.map((ph) => ph.totalWeight),
    cells,
  );
  const overall = phases
    .map((ph, i) => {
      const w = segWidths[i]!;
      const filled =
        ph.totalWeight > 0 ? Math.round((Math.min(ph.doneWeight, ph.totalWeight) / ph.totalWeight) * w) : 0;
      return phaseLetter(i).repeat(filled) + '.'.repeat(w - filled);
    })
    .filter((s) => s.length > 0);
  out.push(`[${overall.join('|')}] ${pct(p.pct, 1)}`, '');

  const glyphOf = new Map<string, string>();
  for (const ph of phases) {
    for (const s of ph.segments)
      if (!glyphOf.has(s.ownerId)) glyphOf.set(s.ownerId, OWNER_GLYPHS[glyphOf.size % OWNER_GLYPHS.length]!);
  }
  const phaseCells = Math.max(10, Math.round(cells / 2));
  const rows = phases.map((ph, i) => {
    const segs = ph.segments.filter((s) => s.totalWeight > 0 || s.doneWeight > 0);
    const done = segs.reduce((a, s) => a + s.doneWeight, 0);
    const widths = apportion(
      [...segs.map((s) => s.doneWeight), Math.max(0, ph.totalWeight - done)],
      phaseCells,
    );
    const stack =
      segs.map((s, j) => glyphOf.get(s.ownerId)!.repeat(widths[j]!)).join('') +
      '.'.repeat(widths[segs.length] ?? 0);
    const manifest = t.manifest.find((m) => m.phaseId === ph.phaseId);
    const live = manifest?.tasks.filter((x) => x.status !== 'removed') ?? null;
    const tasks = live ? `${live.filter((x) => x.status === 'done').length}/${live.length}` : '—';
    const pin = manifest?.pinnedTag ?? (manifest?.pinnedSha ? manifest.pinnedSha.slice(0, 7) : null);
    const state = ph.completedAt ? `complete${pin ? ` @${pin}` : ''}` : 'open';
    const by = segs
      .map(
        (s) =>
          `${glyphOf.get(s.ownerId)} ${oneLine(s.ownerName ?? s.ownerId)} ${s.doneWeight}/${s.totalWeight}`,
      )
      .join(' · ');
    const phPct = ph.totalWeight > 0 ? (ph.doneWeight / ph.totalWeight) * 100 : 0;
    return [
      `${phaseLetter(i)} ${oneLine(ph.name)}`,
      `[${stack}]`,
      pct(phPct, 1),
      `${ph.doneWeight}/${ph.totalWeight}`,
      tasks,
      state,
      by,
    ];
  });
  out.push(
    renderTable(
      [
        { header: 'PHASE', max: 28 },
        { header: 'STACK' },
        { header: 'DONE', align: 'right' },
        { header: 'WEIGHT', align: 'right' },
        { header: 'TASKS', align: 'right' },
        { header: 'STATE' },
        { header: 'CONTRIBUTORS (done/total wt)' },
      ],
      rows,
    ),
  );

  if (t.amendments.length > 0) {
    const last = [...t.amendments].sort((a, b) => a.at.localeCompare(b.at)).at(-1)!;
    out.push(
      '',
      `Amendments: ${t.amendments.length} (latest by ${oneLine(last.byName ?? last.by)}: +${last.added} −${last.removed} ~${last.resized} tasks, weight ${last.prevTotalWeight}→${last.newTotalWeight})`,
    );
  }
  return out.join('\n');
}

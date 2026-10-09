import { describe, expect, it } from 'vitest';
import { LIVENESS_LABEL, LIVENESS_STATES } from '@aoc/contracts';
import {
  apportion,
  bar,
  formatAge,
  formatDuration,
  livenessBadge,
  LIVENESS_SYMBOL,
  oneLine,
  renderKv,
  renderTable,
  renderTimeline,
  sanitize,
  truncate,
} from '../src/format';
import { NOW } from './helpers/cli';
import { timeline } from './helpers/fixtures';

describe('renderTable', () => {
  it('aligns columns with a two-space gutter, right-aligns numbers and trims trailing space', () => {
    const out = renderTable(
      [{ header: 'ID' }, { header: 'COUNT', align: 'right' }, { header: 'NAME' }],
      [
        ['a', 5, 'short'],
        ['bbbb', 1234, 'x'],
      ],
    );
    expect(out.split('\n')).toEqual(['ID    COUNT  NAME', 'a         5  short', 'bbbb   1234  x']);
  });

  it('truncates long cells with an ellipsis and renders null as empty', () => {
    const out = renderTable([{ header: 'T', max: 6 }, { header: 'N' }], [['abcdefghij', null]]);
    expect(out.split('\n')[1]).toBe('abcde…');
  });

  it('strips terminal escapes and newlines from untrusted cells', () => {
    const out = renderTable([{ header: 'TITLE' }], [['evil\u001b[2J\u001b]8;;http://x\u0007title\r\nnext']]);
    expect(out).toBe('TITLE\neviltitle next');
  });
});

describe('sanitize', () => {
  it('removes CSI/OSC sequences and C0/C1 controls but keeps newlines and tabs', () => {
    expect(sanitize('a\u001b[31mred\u001b[0m\tb\nc\u0007\u009bd\u007f')).toBe('ared\tb\ncd');
  });
  it('oneLine collapses whitespace', () => {
    expect(oneLine('  a \n\n b  ')).toBe('a b');
    expect(oneLine(undefined)).toBe('');
  });
  it('truncate counts code points', () => {
    expect(truncate('◆◆◆◆', 3)).toBe('◆◆…');
    expect(truncate('ok', 3)).toBe('ok');
  });
});

describe('livenessBadge', () => {
  it('renders every liveness state as a distinct symbol plus its word', () => {
    const symbols = new Set<string>();
    for (const s of LIVENESS_STATES) {
      const badge = livenessBadge(s);
      expect(badge).toBe(`${LIVENESS_SYMBOL[s]} ${LIVENESS_LABEL[s]}`);
      expect(badge).toMatch(/[A-Za-z]/); // never a symbol (or colour) alone
      symbols.add(LIVENESS_SYMBOL[s]);
    }
    expect(symbols.size).toBe(LIVENESS_STATES.length);
  });
  it('shows the lifecycle word when the session is no longer live', () => {
    expect(livenessBadge(null, 'ended')).toBe('○ Ended');
    expect(livenessBadge(null, 'waiting_decision')).toBe('○ Waiting decision');
    expect(livenessBadge(undefined)).toBe('○ Unknown');
  });
  it('contains no ANSI colour codes', () => {
    for (const s of LIVENESS_STATES) expect(livenessBadge(s)).not.toContain('\u001b');
  });
});

describe('durations', () => {
  it('formats compact ages', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(14 * 60_000)).toBe('14m');
    expect(formatDuration(65 * 60_000)).toBe('1h05m');
    expect(formatDuration(3 * 3600_000)).toBe('3h');
    expect(formatDuration(30 * 3600_000)).toBe('30h');
    expect(formatDuration(5 * 86400_000)).toBe('5d');
  });
  it('formatAge is relative to the injected now and tolerates bad input', () => {
    expect(formatAge('2026-10-09T09:30:00.000Z', NOW)).toBe('30m');
    expect(formatAge('nope', NOW)).toBe('—');
    expect(formatAge(null, NOW)).toBe('—');
  });
});

describe('bars', () => {
  it('apportion always sums to the width (largest remainder)', () => {
    expect(apportion([1, 1, 1], 10)).toEqual([4, 3, 3]);
    expect(apportion([3, 1], 8).reduce((a, b) => a + b)).toBe(8);
    expect(apportion([0, 0], 5)).toEqual([0, 0]);
  });
  it('bar fills proportionally', () => {
    expect(bar(1, 4, 8)).toBe('[##------]');
    expect(bar(0, 0, 4)).toBe('[----]');
    expect(bar(9, 4, 4)).toBe('[####]');
  });
  it('renderKv aligns keys and hides undefined rows', () => {
    expect(
      renderKv([
        ['A', 1],
        ['Long key', null],
        ['Gone', undefined],
      ]),
    ).toBe('A         1\nLong key  —');
  });
});

describe('renderTimeline', () => {
  it('draws the overall bar stacked per phase in phase order, with numbers', () => {
    const lines = renderTimeline(timeline(), 20).split('\n');
    expect(lines[0]).toBe('Alpha (prj_1) — 50.0% done · 10/20 weight · 5/9 tasks');
    // Discovery (A, 4/4 wt) gets 4 of 20 cells, all done; Build (B, 4/16) gets 16 cells, 4 done.
    expect(lines[1]).toBe('[AAAA|BBBB............] 50.0%');
    const body = lines.slice(3).join('\n');
    expect(body).toMatch(/A Discovery\s+\[##########\]\s+100\.0%\s+4\/4\s+2\/2\s+complete @abcdef1/);
    expect(body).toMatch(/B Build\s+\[##=\.{7}\]\s+25\.0%\s+4\/16\s+—\s+open\s+# Alice 3\/10 · = Bob 1\/6/);
    expect(body).toContain('Amendments: 1 (latest by Bob: +2 −0 ~1 tasks, weight 16→20)');
  });

  it('says so when no plan is declared', () => {
    const t = { ...timeline(), phases: [], manifest: [], amendments: [] };
    expect(renderTimeline(t)).toContain('No plan declared yet.');
  });
});

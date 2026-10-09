import { Badge, formatInteger, type IconName, type Tone } from '../../components';
import { cx } from '../../lib/dom';
import type { CoverageLevel, GateCoverage as Gate } from './model';

const LEVEL: Record<CoverageLevel, { word: string; tone: Tone; icon: IconName }> = {
  ok: { word: 'Covered', tone: 'ok', icon: 'ok' },
  warn: { word: 'Single point', tone: 'warn', icon: 'warn' },
  danger: { word: 'Nobody', tone: 'danger', icon: 'danger' },
  unknown: { word: 'Checking', tone: 'neutral', icon: 'clock' },
};

/** Holder marks drawn before the rest fold into "+n". */
const MAX_MARKS = 8;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

export interface GateCoverageProps {
  gates: readonly Gate[];
}

/**
 * Who can clear each kind of gate right now: one mark per holder, a dashed seat for each missing holder, the
 * level as icon + word, and every holder named in text.
 */
export function GateCoverage({ gates }: GateCoverageProps) {
  return (
    <ul className="admin-gates" aria-label="Gate coverage">
      {gates.map((g) => {
        const level = LEVEL[g.level];
        const empty = Math.max(0, g.seats - g.holders.length);
        const shown = g.holders.slice(0, MAX_MARKS);
        const more = g.holders.length - shown.length;
        return (
          <li key={g.id} className={cx('admin-gates__row', `is-${g.level}`)}>
            <div className="admin-gates__what">
              <span className="admin-gates__label">{g.label}</span>
              <span className="admin-muted">{g.scope}</span>
            </div>
            <div className="admin-gates__seats" aria-hidden="true">
              {shown.map((u) => (
                <span key={u.id} className="admin-gates__seat" title={u.name}>
                  {initials(u.name)}
                </span>
              ))}
              {more > 0 && <span className="admin-gates__more aoc-num">+{more}</span>}
              {Array.from({ length: empty }, (_, i) => (
                <span key={`empty-${i}`} className="admin-gates__seat is-empty" />
              ))}
            </div>
            <div className="admin-gates__status">
              <Badge tone={level.tone} icon={level.icon}>
                {level.word}
              </Badge>
              <span className="admin-gates__count aoc-num">
                {formatInteger(g.holders.length)} {g.holders.length === 1 ? 'person' : 'people'}
              </span>
            </div>
            <p className="admin-gates__who">
              {g.holders.length > 0 ? g.holders.map((u) => u.name).join(', ') : 'No one'}
              {g.note && <span className="admin-gates__note"> · {g.note}</span>}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

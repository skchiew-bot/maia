import type { ChangeRequestDTO } from '@aoc/contracts';
import { CopyableHash } from '../../components/CopyableHash';
import { cx } from '../../lib/dom';
import { FIELD_META, FIELD_ORDER, fieldState } from './model';

const SHA = /^[0-9a-f]{7,64}$/i;

export function isSha(ref: string | null | undefined): boolean {
  return !!ref && SHA.test(ref);
}

/**
 * One square per required field: filled when affirmed, outlined while pending, amber when it was a blind
 * one-click confirm. The count is printed beside it and spelled out for screen readers.
 */
export function FieldPips({ change }: { change: ChangeRequestDTO }) {
  const states = FIELD_ORDER.map((f) => {
    const row = change.fields.find((x) => x.field === f);
    return { field: f, state: row ? fieldState(row, change.erased) : ('pending' as const) };
  });
  const affirmed = states.filter((s) => s.state !== 'pending' && s.state !== 'erased').length;
  const blind = states.filter((s) => s.state === 'blind').length;
  const label = `${affirmed} of 4 fields affirmed${blind ? `, ${blind} blind one-click confirm${blind > 1 ? 's' : ''}` : ''}`;
  return (
    <span className="changes-pips" role="img" aria-label={label} title={label}>
      <span className="changes-pips__set" aria-hidden="true">
        {states.map((s) => (
          <span
            key={s.field}
            className={cx('changes-pips__pip', `is-${s.state}`)}
            title={`${FIELD_META[s.field].label}: ${s.state}`}
          />
        ))}
      </span>
      <span className="changes-pips__count aoc-num" aria-hidden="true">
        {affirmed}/4
      </span>
    </span>
  );
}

/** A tag or branch name with the SHA it resolved to; a bare SHA becomes a copyable hash. */
export function RefValue({
  refName,
  sha,
  label,
}: {
  refName: string | null | undefined;
  sha?: string | null;
  label?: string;
}) {
  if (!refName && !sha) return <span className="changes-muted">—</span>;
  if (!refName || isSha(refName)) {
    const full = sha && refName && sha.startsWith(refName) ? sha : (refName ?? sha)!;
    return <CopyableHash value={full} label={label ? `${label} commit` : 'commit'} />;
  }
  return (
    <span className="changes-ref">
      <code className="changes-ref__name" title={refName}>
        {refName}
      </code>
      {sha && <CopyableHash value={sha} label={`${refName} commit`} />}
    </span>
  );
}

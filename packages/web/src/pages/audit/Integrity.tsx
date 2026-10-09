import type { AnchorCheckDTO, AuditHealthDTO, VerifyReportDTO } from '@aoc/contracts';
import { Badge } from '../../components/Badge';
import { CopyableHash } from '../../components/CopyableHash';
import { InlineAlert } from '../../components/EmptyState';
import { Icon } from '../../components/Icon';
import { RelativeTime } from '../../components/RelativeTime';
import { cx } from '../../lib/dom';
import { formatInteger, formatPercent } from '../../lib/format';
import { ActorName } from './people';
import { parseProofRef, verifyVerdict, type ChainCoverage } from './model';
import type { Actor } from '@aoc/contracts';

/**
 * The chain as one bar from #1 to the head: the part covered by an off-host anchor, and the unanchored tail a
 * host-level attacker could still rewrite (the anchor interval is the window of undetectable tampering, R2).
 */
export function ChainBar({ coverage }: { coverage: ChainCoverage }) {
  const c = coverage;
  const summary =
    c.anchoredThrough > 0
      ? `${formatInteger(c.anchoredThrough)} of ${formatInteger(c.headSeq)} events (${formatPercent(c.ratio)}) are at or before the last anchor; ${formatInteger(c.unanchored)} newer ${c.unanchored === 1 ? 'event is' : 'events are'} not anchored yet.`
      : `None of the ${formatInteger(c.headSeq)} events is anchored yet.`;
  return (
    <figure className="audit-chainbar">
      <div className="audit-chainbar__plot" role="img" aria-label={summary}>
        <div className="audit-chainbar__track">
          <span className="audit-chainbar__anchored" style={{ width: `${c.ratio * 100}%` }} />
          <span className="audit-chainbar__tail" style={{ width: `${(1 - c.ratio) * 100}%` }} />
        </div>
        {c.ticks.map((t) => (
          <span key={t.seq} className="audit-chainbar__tick" style={{ left: `${t.at * 100}%` }} aria-hidden="true">
            <Icon name="key" size={10} />
          </span>
        ))}
      </div>
      <figcaption className="audit-chainbar__labels aoc-num" aria-hidden="true">
        <span>#1</span>
        {c.anchoredThrough > 0 && (
          <span className="audit-chainbar__mid">
            anchored through <strong>#{formatInteger(c.anchoredThrough)}</strong>
          </span>
        )}
        <span>
          head <strong>#{formatInteger(c.headSeq)}</strong>
        </span>
      </figcaption>
      <ul className="audit-chainbar__legend">
        <li>
          <span className="audit-chainbar__swatch is-anchored" aria-hidden="true" />
          Covered by an anchor <strong className="aoc-num">{formatInteger(c.anchoredThrough)}</strong>
        </li>
        <li>
          <span className="audit-chainbar__swatch is-tail" aria-hidden="true" />
          Not yet anchored <strong className="aoc-num">{formatInteger(c.unanchored)}</strong>
        </li>
        <li>
          <Icon name="key" size={10} /> anchor
        </li>
      </ul>
    </figure>
  );
}

function YesNo({ value, yes = 'yes', no = 'no', unknown = 'not checked' }: { value: boolean | null; yes?: string; no?: string; unknown?: string }) {
  if (value === null) return <span className="audit-muted">{unknown}</span>;
  return (
    <span className={cx('audit-yesno', value ? 'is-yes' : 'is-no')}>
      <Icon name={value ? 'check' : 'close'} size={12} />
      {value ? yes : no}
    </span>
  );
}

/** Each external anchor's proof from the last Verify run. */
export function AnchorProofs({ anchors }: { anchors: readonly AnchorCheckDTO[] }) {
  return (
    <div className="audit-proofs" role="region" aria-label="Anchor proofs" tabIndex={0}>
      <table className="audit-proofs__table">
        <caption className="aoc-sr-only">Each external anchor checked by this verification</caption>
        <thead>
          <tr>
            <th scope="col">Anchor</th>
            <th scope="col">Anchored hash</th>
            <th scope="col">Recomputed now</th>
            <th scope="col">Match</th>
            <th scope="col">Proof</th>
            <th scope="col">Signed</th>
            <th scope="col">Off-host copy</th>
          </tr>
        </thead>
        <tbody>
          {anchors.map((a) => {
            const proof = a.proofRef ? parseProofRef(a.proofRef) : null;
            return (
              <tr key={`${a.provider}:${a.seq}:${a.anchorId ?? ''}`} className={a.matched && a.proofOk ? undefined : 'is-bad'}>
                <th scope="row">
                  <span className="audit-proofs__anchor">
                    {a.provider === 'git' ? 'Git commit' : 'RFC 3161 timestamp'}
                    <span className="aoc-num">#{formatInteger(a.seq)}</span>
                    {a.anchoredAt && (
                      <span className="audit-muted">
                        <RelativeTime value={a.anchoredAt} suffix=" ago" />
                      </span>
                    )}
                  </span>
                </th>
                <td>
                  <CopyableHash value={a.anchoredHash} label={`anchored hash at ${a.seq}`} />
                </td>
                <td>
                  {a.recomputedHash ? (
                    <CopyableHash value={a.recomputedHash} label={`recomputed hash at ${a.seq}`} />
                  ) : (
                    <span className="audit-muted">not reached</span>
                  )}
                </td>
                <td>
                  <YesNo value={a.matched} yes="matches" no="differs" />
                </td>
                <td>
                  <span className="audit-proofs__proof">
                    <YesNo value={a.proofOk} yes="valid" no="invalid" />
                    {proof?.kind === 'git' ? (
                      <span className="audit-muted">
                        commit <code>{proof.commit.slice(0, 10)}</code> · {proof.path}
                      </span>
                    ) : proof ? (
                      <span className="audit-muted">{proof.ref}</span>
                    ) : null}
                  </span>
                  {a.problems.length > 0 && (
                    <ul className="audit-proofs__problems">
                      {a.problems.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  )}
                </td>
                <td>
                  <YesNo value={a.signed} unknown="n/a" />
                </td>
                <td>
                  <YesNo value={a.offHost} yes="present" no="missing" />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export interface LastVerification {
  at: string;
  ok: boolean;
  actor: Actor | null;
  checked: number | null;
  anchorsChecked: number | null;
  anchorsMatched: number | null;
}

/** The verdict: from this page's Verify run when there is one, else the last recorded run. */
export function VerifyResult({
  report,
  offHost,
  last,
  health,
}: {
  report: VerifyReportDTO | null;
  offHost: boolean;
  last: LastVerification | null;
  health: AuditHealthDTO;
}) {
  if (report) {
    const v = verifyVerdict(report, offHost);
    return (
      <div className="audit-verdict" aria-live="polite">
        <InlineAlert tone={v.tone === 'accent' || v.tone === 'neutral' ? 'info' : v.tone} title={v.title}>
          {v.detail}
        </InlineAlert>
        <dl className="audit-facts">
          <div>
            <dt>In-file chain</dt>
            <dd>
              <YesNo value={report.chainOk} yes="recomputes" no="broken" /> ·{' '}
              <span className="aoc-num">{formatInteger(report.checked)}</span> events
            </dd>
          </div>
          <div>
            <dt>Head</dt>
            <dd>
              <span className="aoc-num">#{formatInteger(report.headSeq)}</span>{' '}
              <CopyableHash value={report.headHash} label="chain head hash" />
            </dd>
          </div>
          <div>
            <dt>Anchors matched</dt>
            <dd className="aoc-num">
              {formatInteger(report.anchors.filter((a) => a.matched && a.proofOk).length)} of{' '}
              {formatInteger(report.anchors.length)}
            </dd>
          </div>
          <div>
            <dt>Remote fetched</dt>
            <dd>
              <YesNo value={report.remoteChecked} unknown="no remote configured" />
            </dd>
          </div>
          <div>
            <dt>Verified</dt>
            <dd>
              <RelativeTime value={report.verifiedAt} suffix=" ago" />
              {report.eventSeq !== null && <span className="audit-muted"> · recorded as #{formatInteger(report.eventSeq)}</span>}
            </dd>
          </div>
        </dl>
        {report.anchors.length > 0 && <AnchorProofs anchors={report.anchors} />}
        {[...report.problems, ...report.warnings].length > 0 && (
          <ul className="audit-findings">
            {report.problems.map((p) => (
              <li key={`p:${p}`} className="is-problem">
                <Icon name="danger" size={12} /> {p}
              </li>
            ))}
            {report.warnings.map((w) => (
              <li key={`w:${w}`} className="is-warning">
                <Icon name="warn" size={12} /> {w}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  const lv = health.lastVerification;
  return (
    <div className="audit-verdict">
      {lv ? (
        <p className="audit-verdict__last">
          <Badge tone={lv.ok ? 'ok' : 'danger'} icon={lv.ok ? 'ok' : 'danger'}>
            {lv.ok ? 'Last run passed' : 'Last run failed'}
          </Badge>{' '}
          Verified <RelativeTime value={lv.at} suffix=" ago" />
          {last?.actor && (
            <>
              {' '}
              by <ActorName actor={last.actor} />
            </>
          )}
          {last && last.anchorsChecked !== null && (
            <>
              {' '}
              · {formatInteger(last.anchorsMatched ?? 0)} of {formatInteger(last.anchorsChecked)} anchors matched
            </>
          )}
          {lv.firstBadSeq !== null && <> · first bad event #{formatInteger(lv.firstBadSeq)}</>}
          . Run Verify to see each anchor's proof.
        </p>
      ) : (
        <p className="audit-verdict__last">The chain has never been verified. Run Verify to check it against every anchor.</p>
      )}
    </div>
  );
}

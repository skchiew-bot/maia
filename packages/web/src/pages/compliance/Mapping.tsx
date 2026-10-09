import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { ComplianceMappingDTO, ComplianceMappingRowDTO } from '@aoc/contracts';
import { apiPost } from '../../api/client';
import {
  Badge,
  Button,
  Checkbox,
  Chip,
  CopyableHash,
  DataTable,
  Dialog,
  EmptyState,
  Icon,
  InlineAlert,
  RelativeTime,
  Select,
  TextArea,
  TextField,
  describeError,
  useToast,
  type DataTableColumn,
} from '../../components';
import { cx } from '../../lib/dom';
import { formatInteger } from '../../lib/format';
import { PersonName, usePeople } from '../audit/people';
import { clauseFamily, compareClauses, familyCounts } from './model';

/** Mapped rows per clause family as one strip; every segment carries its count, and the state is in words. */
export function CoverageStrip({
  rows,
  stamped,
}: {
  rows: readonly ComplianceMappingRowDTO[];
  stamped: boolean;
}) {
  const counts = familyCounts(rows);
  const total = rows.length || 1;
  const max = Math.max(1, ...counts.map((c) => c.rows));
  const summary = `${formatInteger(rows.length)} mapped rows across ${counts.length} clause families, all ${
    stamped ? 'stamped' : 'provisional'
  }: ${counts.map((c) => `${c.family.label} ${c.rows}`).join(', ')}.`;
  return (
    <figure className="compliance-strip">
      <div className="compliance-strip__bar" role="img" aria-label={summary}>
        {counts.map((c) => (
          <span
            key={c.family.key}
            className={cx(
              'compliance-strip__seg',
              c.family.annex ? 'is-annex' : 'is-clause',
              stamped ? 'is-stamped' : 'is-provisional',
            )}
            style={{ '--share': c.rows / total, '--rel': c.rows / max } as CSSProperties}
            title={`${c.family.label}: ${c.rows} ${c.rows === 1 ? 'row' : 'rows'}`}
          >
            <span className="compliance-strip__key">{c.family.key}</span>
            <strong className="aoc-num">{c.rows}</strong>
          </span>
        ))}
      </div>
      <figcaption className="compliance-strip__legend">
        <span>
          <span className="compliance-strip__swatch is-clause" aria-hidden="true" /> main clauses
        </span>
        <span>
          <span className="compliance-strip__swatch is-annex" aria-hidden="true" /> Annex A controls
        </span>
        <span>
          {stamped ? 'solid: stamped by the compliance lead' : 'hatched: provisional until stamped'}
        </span>
      </figcaption>
    </figure>
  );
}

function StampDialog({
  mapping,
  open,
  onClose,
  onStamped,
}: {
  mapping: ComplianceMappingDTO;
  open: boolean;
  onClose: () => void;
  onStamped: (m: ComplianceMappingDTO) => void;
}) {
  const toast = useToast();
  const [reviewed, setReviewed] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const corrections = mapping.rows.filter((r) => r.correctionNote).length;

  const stamp = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const m = await apiPost<ComplianceMappingDTO>('/api/compliance/mapping/stamp', {
        version: mapping.version,
        hash: mapping.hash,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      toast.notify({ tone: 'ok', title: 'Mapping stamped', body: m.statement });
      onStamped(m);
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Stamp the ISO/IEC 42001 mapping"
      description="Your stamp is bound to this exact mapping hash. Any later edit to the mapping makes it provisional again."
      dismissOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="check"
            disabled={!reviewed}
            loading={busy}
            loadingText="Stamping…"
            onClick={() => void stamp()}
          >
            Stamp mapping
          </Button>
        </>
      }
    >
      <div className="compliance-form">
        <dl className="compliance-facts">
          <div>
            <dt>Version</dt>
            <dd>{mapping.version}</dd>
          </div>
          <div>
            <dt>Mapping hash</dt>
            <dd>
              <CopyableHash value={mapping.hash} length={16} label="mapping hash" />
            </dd>
          </div>
          <div>
            <dt>Rows</dt>
            <dd className="aoc-num">{formatInteger(mapping.rows.length)}</dd>
          </div>
          <div>
            <dt>Rows with a correction note</dt>
            <dd className="aoc-num">{formatInteger(corrections)}</dd>
          </div>
        </dl>
        {error !== undefined && (
          <InlineAlert tone="danger" title="Not stamped" live>
            {describeError(error)}
          </InlineAlert>
        )}
        <Checkbox
          label="I confirmed every row against ISO/IEC 42001:2023, including each clause correction."
          checked={reviewed}
          onChange={(e) => setReviewed(e.target.checked)}
        />
        <TextArea
          label="Review note (optional)"
          rows={3}
          maxLength={2000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          hint="Kept with the stamp in the encrypted body store."
        />
      </div>
    </Dialog>
  );
}

const REASON_TEXT: Record<string, string> = {
  compliance_lead_required: 'Only the compliance lead can stamp the mapping.',
  role: 'Your role cannot see the internal audit surface.',
  permission: 'Your account cannot stamp the mapping.',
};

/** Can this mapping be cited? Provisional until the compliance lead stamps its exact hash (R3). */
export function MappingStatus({
  mapping,
  onStamped,
}: {
  mapping: ComplianceMappingDTO;
  onStamped: (m: ComplianceMappingDTO) => void;
}) {
  const [stamping, setStamping] = useState(false);
  const { complianceLeads } = usePeople();
  const stamped = mapping.status === 'stamped';
  const corrections = mapping.rows.filter((r) => r.correctionNote).length;
  return (
    <div className="compliance-status">
      <div
        className={cx('compliance-status__banner', stamped ? 'is-stamped' : 'is-provisional')}
        role="status"
      >
        <Icon name={stamped ? 'ok' : 'warn'} size={20} />
        <div>
          <p className="compliance-status__title">
            {stamped ? 'Stamped — citable' : (mapping.banner ?? 'Provisional — do not cite')}
          </p>
          <p className="compliance-status__statement">{mapping.statement}</p>
        </div>
        {mapping.viewer.canStamp && !stamped && (
          <Button variant="primary" icon="check" onClick={() => setStamping(true)}>
            Review and stamp
          </Button>
        )}
      </div>
      <dl className="compliance-facts">
        <div>
          <dt>Standard</dt>
          <dd>{mapping.standard}</dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>{mapping.version}</dd>
        </div>
        <div>
          <dt>Mapping hash</dt>
          <dd>
            <CopyableHash value={mapping.hash} label="mapping hash" />
          </dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{mapping.source === 'config' ? 'mapping file' : 'built-in default'}</dd>
        </div>
        <div>
          <dt>Active since</dt>
          <dd>{mapping.publishedAt ? <RelativeTime value={mapping.publishedAt} suffix=" ago" /> : '—'}</dd>
        </div>
        <div>
          <dt>{stamped ? 'Stamped by' : 'Who can stamp'}</dt>
          <dd>
            {stamped && mapping.stamp ? (
              <>
                <PersonName id={mapping.stamp.by} /> on {mapping.stamp.localDate}
              </>
            ) : complianceLeads.length ? (
              complianceLeads.map((p, i) => (
                <span key={p.id}>
                  {i > 0 && ', '}
                  <PersonName id={p.id} /> (compliance lead)
                </span>
              ))
            ) : (
              'the compliance lead (no one holds the flag yet)'
            )}
          </dd>
        </div>
      </dl>
      {!stamped && !mapping.viewer.canStamp && mapping.viewer.reason && (
        <p className="compliance-muted">
          <Icon name="info" size={12} /> {REASON_TEXT[mapping.viewer.reason] ?? mapping.viewer.reason}
        </p>
      )}
      {stamped && mapping.stamp?.note && <p className="compliance-note">“{mapping.stamp.note}”</p>}
      <CoverageStrip rows={mapping.rows} stamped={stamped} />
      <p className="compliance-muted">
        {formatInteger(mapping.rows.length)} rows map AOC controls to clauses; {formatInteger(corrections)}{' '}
        carry a correction or review note from the mapping itself.
      </p>
      {mapping.warnings.length > 0 && (
        <InlineAlert tone="warn" title="The mapping file was not used as written">
          <ul className="compliance-list">
            {mapping.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </InlineAlert>
      )}
      {mapping.notes && (
        <details className="compliance-details">
          <summary>Mapping notes</summary>
          <p>{mapping.notes}</p>
        </details>
      )}
      <StampDialog
        mapping={mapping}
        open={stamping}
        onClose={() => setStamping(false)}
        onStamped={onStamped}
      />
    </div>
  );
}

/** Long text trimmed to a few lines with a more/less toggle; the full text stays in the DOM for screen readers. */
function Clamp({ text, lines, label }: { text: string; lines: number; label: string }) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, text]);
  return (
    <span className="compliance-clamp">
      <span
        ref={ref}
        className={cx('compliance-clamp__text', !open && 'is-clamped')}
        style={open ? undefined : { WebkitLineClamp: lines }}
      >
        {text}
      </span>
      {(open || overflows) && (
        <button
          type="button"
          className="aoc-link-button compliance-clamp__toggle"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'less' : 'more'}
          <span className="aoc-sr-only"> of the {label}</span>
        </button>
      )}
    </span>
  );
}

function RowStatus({ status }: { status: ComplianceMappingRowDTO['status'] }) {
  return status === 'stamped' ? (
    <Badge tone="ok" icon="ok">
      stamped
    </Badge>
  ) : (
    <Badge tone="warn" icon="warn">
      provisional
    </Badge>
  );
}

/** Clause → evidence, one row per mapped AOC control, in clause order. */
export function MappingTable({ mapping }: { mapping: ComplianceMappingDTO }) {
  const [family, setFamily] = useState('');
  const [search, setSearch] = useState('');
  const families = useMemo(() => familyCounts(mapping.rows), [mapping.rows]);
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...mapping.rows]
      .filter((r) => !family || clauseFamily(r.clause).key === family)
      .filter(
        (r) =>
          !q ||
          [r.clause, r.clauseTitle, r.aocControl, r.aocFeature, ...r.evidence].some((t) =>
            t.toLowerCase().includes(q),
          ),
      )
      .sort((a, b) => compareClauses(a.clause, b.clause));
  }, [mapping.rows, family, search]);

  const rank = useMemo(() => {
    const sorted = [...mapping.rows].sort((a, b) => compareClauses(a.clause, b.clause));
    return new Map(sorted.map((r, i) => [r.id, i]));
  }, [mapping.rows]);

  const columns = useMemo<DataTableColumn<ComplianceMappingRowDTO>[]>(
    () => [
      {
        id: 'clause',
        header: 'Clause',
        primary: true,
        width: '22%',
        sortValue: (r) => rank.get(r.id),
        cell: (r) => (
          <span className="compliance-clause">
            <span className="compliance-clause__head">
              <code>{r.clause}</code>
              <RowStatus status={r.status} />
            </span>
            <span>{r.clauseTitle}</span>
            {r.relatedClauses.length > 0 && (
              <span className="compliance-muted">also {r.relatedClauses.join(', ')}</span>
            )}
          </span>
        ),
      },
      {
        id: 'control',
        header: 'AOC control',
        width: '26%',
        cell: (r) => (
          <span className="compliance-control">
            <strong>{r.aocControl}</strong>
            <span className="compliance-muted">
              <Clamp text={r.aocFeature} lines={2} label="AOC feature" />
            </span>
          </span>
        ),
      },
      {
        id: 'evidence',
        header: 'Evidence',
        cell: (r) => (
          <span className="compliance-evidence">
            {r.evidence.length > 0 && <Clamp text={r.evidence.join(' · ')} lines={4} label="evidence" />}
            {r.eventTypes.length > 0 && (
              <span className="compliance-chips" aria-label="Event types an auditor can query">
                {r.eventTypes.slice(0, 6).map((t) => (
                  <Chip key={t}>{t}</Chip>
                ))}
                {r.eventTypes.length > 6 && (
                  <span className="compliance-muted">+{r.eventTypes.length - 6} event types</span>
                )}
              </span>
            )}
          </span>
        ),
      },
      {
        id: 'note',
        header: 'Correction / review note',
        width: '26%',
        cell: (r) =>
          r.correctionNote ? (
            <span className="compliance-correction">
              <Clamp text={r.correctionNote} lines={3} label="correction note" />
            </span>
          ) : (
            <span className="compliance-muted">—</span>
          ),
      },
    ],
    [rank],
  );

  return (
    <div className="compliance-table">
      <div className="compliance-table__filters">
        <Select
          label="Clause family"
          fieldClassName="compliance-filter"
          value={family}
          onChange={(e) => setFamily(e.target.value)}
          options={[
            { value: '', label: `All (${formatInteger(mapping.rows.length)} rows)` },
            ...families.map((f) => ({ value: f.family.key, label: `${f.family.label} (${f.rows})` })),
          ]}
        />
        <TextField
          label="Search"
          fieldClassName="compliance-filter"
          type="search"
          value={search}
          placeholder="clause, control or evidence"
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="compliance-muted aoc-num">
          {formatInteger(rows.length)} of {formatInteger(mapping.rows.length)} rows
        </span>
      </div>
      <DataTable
        caption="ISO/IEC 42001 clause to AOC evidence mapping"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        empty={
          <EmptyState
            size="sm"
            title="No row matches"
            body="Clear the search or choose another clause family."
          />
        }
      />
    </div>
  );
}

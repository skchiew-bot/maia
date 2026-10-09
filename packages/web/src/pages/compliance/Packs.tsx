import { useCallback, useMemo, useRef, useState, type FormEvent } from 'react';
import type { EvidencePackDetailDTO, EvidencePackJobDTO, EvidencePackSummaryDTO } from '@aoc/contracts';
import { apiGet, apiPost } from '../../api/client';
import { useResource } from '../../api/useResource';
import {
  Badge,
  Button,
  CopyableHash,
  DataTable,
  DescriptionList,
  Drawer,
  EmptyState,
  Icon,
  InlineAlert,
  RelativeTime,
  TextField,
  describeError,
  useToast,
  type DataTableColumn,
} from '../../components';
import { formatDateTime, formatInteger } from '../../lib/format';
import { ActorName } from '../audit/people';
import { LoadFailed, Skeleton } from '../audit/Skeleton';
import { shortId } from '../audit/ids';
import { defaultRange, formatBytes, packVerdict, rangeDays } from './model';
import {
  POLL_MS,
  RUN_WORD,
  isPending,
  jobPath,
  refusalOf,
  requestedRun,
  retryText,
  runOfAnswer,
  runOfJob,
  useFollowRun,
  type PackRun,
  type Refusal,
} from './packRun';

const MAX_DAYS = 366;

/** Where one pack request stands: queued behind another build, building, ready to download, or failed. */
function PackRunAlert({ run, onDismiss }: { run: PackRun; onDismiss?: () => void }) {
  const range = `${run.from} to ${run.to}`;
  if (run.status === 'failed')
    return (
      <InlineAlert
        tone="danger"
        title={`${RUN_WORD.failed}: no pack was generated`}
        live
        onDismiss={onDismiss}
      >
        {range}: {run.error ?? 'the build did not finish'}
      </InlineAlert>
    );
  if (run.status === 'done' && run.pack) {
    const verdict = packVerdict(run.pack);
    return (
      <InlineAlert
        tone={verdict.ok ? 'ok' : 'warn'}
        title={`${RUN_WORD.done}: ${range}`}
        live
        onDismiss={onDismiss}
        action={
          <a className="aoc-btn aoc-btn--secondary aoc-btn--sm" href={run.pack.downloadUrl} download>
            <Icon name="arrow-down" size={14} />
            <span className="aoc-btn__label">Download .zip</span>
          </a>
        }
      >
        {formatInteger(run.pack.eventCount)} events · {verdict.label}
      </InlineAlert>
    );
  }
  if (run.status === 'queued')
    return (
      <InlineAlert tone="info" title={`${RUN_WORD.queued}: ${range}`} live>
        {run.position === 1
          ? 'Builds next.'
          : run.position
            ? `Number ${formatInteger(run.position)} in line.`
            : 'Waiting for its turn.'}{' '}
        Packs are built one at a time.
      </InlineAlert>
    );
  return (
    <InlineAlert tone="info" title={`${RUN_WORD.running}: ${range}`} live>
      Re-hashing the whole chain and checking the anchors, which takes a while on a long log. The pack is
      listed below when it is ready, even if you leave this page.
    </InlineAlert>
  );
}

export function GeneratePackForm({
  now,
  onGenerated,
  pollMs = POLL_MS,
}: {
  now: number;
  onGenerated: (p: EvidencePackSummaryDTO) => void;
  /** How often a queued or running pack is checked. */
  pollMs?: number;
}) {
  const toast = useToast();
  const initial = useMemo(() => defaultRange(now), [now]);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [run, setRun] = useState<PackRun | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [error, setError] = useState<unknown>(undefined);
  const announced = useRef(new Set<string>());
  const days = rangeDays(from, to);
  const pending = isPending(run);
  const problem =
    !from || !to
      ? 'Choose both dates.'
      : days === 0
        ? 'The end date is before the start date.'
        : days > MAX_DAYS
          ? `A pack covers at most ${MAX_DAYS} days.`
          : null;

  const settle = useCallback(
    (next: PackRun) => {
      setRun(next);
      const p = next.pack;
      if (next.status !== 'done' || !p || announced.current.has(p.packId)) return;
      announced.current.add(p.packId);
      const verdict = packVerdict(p);
      toast.notify({
        tone: verdict.ok ? 'ok' : 'warn',
        title: `Evidence pack frozen: ${p.from} to ${p.to}`,
        body: `${formatInteger(p.eventCount)} events · ${verdict.label}`,
      });
      onGenerated(p);
    },
    [toast, onGenerated],
  );
  useFollowRun(run, settle, pollMs);

  /** The pack this person already has pending is the one worth watching when a second request is refused. */
  const follow = async (jobId: string) => {
    try {
      settle(runOfJob(await apiGet<EvidencePackJobDTO>(jobPath(jobId))));
    } catch {
      // The refusal already says why; the status of that pack is a courtesy.
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problem || pending) return;
    setError(undefined);
    setRefusal(null);
    setRun(requestedRun(from, to));
    try {
      const answer = runOfAnswer(await apiPost<unknown>('/api/evidence/packs', { from, to }));
      if (!answer) throw new Error('The daemon answered with neither a pack nor a queued job.');
      settle(answer);
    } catch (err) {
      setRun(null);
      const refused = refusalOf(err);
      if (!refused) setError(err);
      else {
        setRefusal(refused);
        if (refused.jobId) void follow(refused.jobId);
      }
    }
  };

  return (
    <form className="compliance-generate" onSubmit={submit} noValidate>
      <TextField
        label="From"
        type="date"
        required
        value={from}
        max={to || undefined}
        onChange={(e) => setFrom(e.target.value)}
      />
      <TextField
        label="To (inclusive)"
        type="date"
        required
        value={to}
        min={from || undefined}
        onChange={(e) => setTo(e.target.value)}
      />
      <div className="compliance-generate__submit">
        <Button
          type="submit"
          variant="primary"
          icon="compliance"
          disabled={!!problem}
          loading={pending}
          loadingText={run?.status === 'queued' ? 'Queued…' : 'Building…'}
        >
          Generate frozen pack
        </Button>
        <span className="compliance-muted">
          {problem ??
            (pending
              ? 'Packs build one at a time: ask for the next once this one is ready.'
              : `${formatInteger(days)} ${days === 1 ? 'day' : 'days'}, in the console's time zone`)}
        </span>
      </div>
      {refusal && (
        <InlineAlert tone="warn" title={refusal.message} live onDismiss={() => setRefusal(null)}>
          {retryText(refusal)}
        </InlineAlert>
      )}
      {run && <PackRunAlert run={run} onDismiss={pending ? undefined : () => setRun(null)} />}
      {error !== undefined && (
        <InlineAlert tone="danger" title="No pack was generated" live>
          {describeError(error)}
        </InlineAlert>
      )}
    </form>
  );
}

function PackDetail({ packId }: { packId: string }) {
  const res = useResource<EvidencePackDetailDTO>(`/api/evidence/packs/${encodeURIComponent(packId)}`);
  if (!res.data) {
    if (res.error) return <LoadFailed what="the pack" error={res.error} onRetry={res.reload} />;
    return <Skeleton label="Re-hashing the stored pack" blocks={[140, 120]} />;
  }
  const p = res.data;
  const m = p.manifest;
  return (
    <div className="compliance-drawer">
      {p.integrity === 'ok' ? (
        <InlineAlert tone="ok" title="Stored pack matches its recorded hash">
          Re-hashed just now; the download is the frozen artefact.
        </InlineAlert>
      ) : (
        <InlineAlert
          tone="danger"
          title={p.integrity === 'missing' ? 'The stored pack is missing' : 'The stored pack was altered'}
        >
          Downloads are refused and the failure is recorded in the chain.
        </InlineAlert>
      )}
      <DescriptionList
        columns={2}
        items={[
          {
            term: 'Range',
            value: `${p.from} to ${p.to}${m ? ` (${m.range.timezone}, ${m.range.days} days${m.range.complete ? '' : ', not yet elapsed'})` : ''}`,
          },
          {
            term: 'Generated',
            value: (
              <>
                {formatDateTime(p.generatedAt)} by <ActorName actor={p.generatedBy} />
              </>
            ),
          },
          { term: 'Events', value: formatInteger(p.eventCount) },
          { term: 'Chain head at generation', value: `#${formatInteger(p.headSeq)}` },
          {
            term: 'Pack hash (sha256)',
            value: <CopyableHash value={p.packHash} length={16} label="pack hash" />,
          },
          { term: 'Size', value: formatBytes(p.bytes) },
          { term: 'Mapping', value: `${p.mappingVersion} · ${p.mappingStamped ? 'stamped' : 'provisional'}` },
          { term: 'Rate card', value: `v${p.rateCardVersion}` },
        ]}
      />
      {m && (
        <>
          <h3 className="compliance-drawer__title">Verification recorded in the pack</h3>
          <ul className="compliance-checks">
            <li className={m.verification.chainOk ? 'is-ok' : 'is-bad'}>
              <Icon name={m.verification.chainOk ? 'check' : 'danger'} size={14} /> Whole chain recomputes
            </li>
            <li
              className={
                m.verification.anchorsMatched === m.verification.anchorsChecked &&
                m.verification.anchorsChecked > 0
                  ? 'is-ok'
                  : 'is-bad'
              }
            >
              <Icon
                name={
                  m.verification.anchorsMatched === m.verification.anchorsChecked &&
                  m.verification.anchorsChecked > 0
                    ? 'check'
                    : 'warn'
                }
                size={14}
              />
              {formatInteger(m.verification.anchorsMatched)} of {formatInteger(m.verification.anchorsChecked)}{' '}
              anchors match
            </li>
            <li className={m.verification.rangeCoveredByAnchor ? 'is-ok' : 'is-bad'}>
              <Icon name={m.verification.rangeCoveredByAnchor ? 'check' : 'warn'} size={14} />
              {m.verification.rangeCoveredByAnchor
                ? 'The whole range is covered by an anchor'
                : `${formatInteger(m.verification.unanchoredTailEvents)} events in range are after the last anchor`}
            </li>
          </ul>
          <h3 className="compliance-drawer__title">Mapping stamp embedded</h3>
          <p>{m.mapping.statement}</p>
          <h3 className="compliance-drawer__title">Files ({formatInteger(m.files.length)})</h3>
          <ul className="compliance-files">
            {m.files.map((f) => (
              <li key={f.path}>
                <code>{f.path}</code>
                <span className="compliance-muted">{formatBytes(f.bytes)}</span>
                <CopyableHash value={f.sha256} label={`${f.path} sha256`} />
              </li>
            ))}
          </ul>
          <p className="compliance-muted">{m.privacy}</p>
        </>
      )}
      <a className="aoc-btn aoc-btn--secondary aoc-btn--md" href={p.downloadUrl} download>
        <Icon name="arrow-down" size={16} />
        <span className="aoc-btn__label">Download the pack (.zip)</span>
      </a>
    </div>
  );
}

export function PacksTable({ packs }: { packs: readonly EvidencePackSummaryDTO[] }) {
  const [open, setOpen] = useState<EvidencePackSummaryDTO | null>(null);
  const columns = useMemo<DataTableColumn<EvidencePackSummaryDTO>[]>(
    () => [
      {
        id: 'range',
        header: 'Range',
        primary: true,
        sortValue: (p) => p.to,
        cell: (p) => (
          <span className="compliance-pack">
            <span className="aoc-num">
              {p.from} → {p.to}
            </span>
            <span className="compliance-muted">{shortId(p.packId)}</span>
          </span>
        ),
      },
      {
        id: 'events',
        header: 'Events',
        numeric: true,
        sortValue: (p) => p.eventCount,
        cell: (p) => formatInteger(p.eventCount),
      },
      {
        id: 'verify',
        header: 'Verification',
        cell: (p) => {
          const v = packVerdict(p);
          return (
            <Badge tone={v.tone} icon={v.ok ? 'ok' : v.tone === 'danger' ? 'danger' : 'warn'}>
              {v.label}
            </Badge>
          );
        },
      },
      {
        id: 'mapping',
        header: 'Mapping',
        cell: (p) => (
          <span>
            {p.mappingStamped ? 'stamped' : 'provisional'}{' '}
            <span className="compliance-muted">{p.mappingVersion}</span>
          </span>
        ),
      },
      {
        id: 'hash',
        header: 'Pack hash',
        cell: (p) => <CopyableHash value={p.packHash} label="pack hash" />,
      },
      {
        id: 'by',
        header: 'Generated',
        numeric: true,
        sortValue: (p) => p.generatedAt,
        cell: (p) => (
          <span className="compliance-generated">
            <RelativeTime value={p.generatedAt} suffix=" ago" />
            <ActorName actor={p.generatedBy} />
          </span>
        ),
      },
      {
        id: 'download',
        header: 'Download',
        hideHeader: true,
        align: 'end',
        cell: (p) => (
          <a
            className="compliance-download"
            href={p.downloadUrl}
            download
            aria-label={`Download pack ${p.from} to ${p.to}`}
          >
            <Icon name="arrow-down" size={14} /> .zip
          </a>
        ),
      },
    ],
    [],
  );
  return (
    <>
      <DataTable
        caption="Frozen evidence packs"
        columns={columns}
        rows={packs}
        rowKey={(p) => p.packId}
        onRowClick={setOpen}
        rowLabel={(p) => `Pack ${p.from} to ${p.to}: open its manifest`}
        activeRowKey={open?.packId}
        empty={
          <EmptyState
            size="sm"
            icon="compliance"
            title="No evidence pack yet"
            body="Generate one for a date range: it freezes the chained headers, the verification, the control mapping and the rate card into one hash-verified file."
          />
        }
      />
      <Drawer
        open={open !== null}
        onClose={() => setOpen(null)}
        width={560}
        title={open ? `Evidence pack ${open.from} → ${open.to}` : ''}
        description={open ? shortId(open.packId) : undefined}
      >
        {open && <PackDetail packId={open.packId} />}
      </Drawer>
    </>
  );
}

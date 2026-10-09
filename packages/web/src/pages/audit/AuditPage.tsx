import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type {
  AnchorListDTO,
  AnchorResultDTO,
  AuditEventHeaderDTO,
  AuditEventPageDTO,
  AuditHealthDTO,
  VerifyReportDTO,
} from '@aoc/contracts';
import { useAuth } from '../../api/auth';
import { apiGet, apiPost } from '../../api/client';
import type { StreamMessage } from '../../api/stream';
import { useResource } from '../../api/useResource';
import {
  Button,
  FilterBar,
  Icon,
  InlineAlert,
  PageHeader,
  SegmentedControl,
  Select,
  TextField,
  Widget,
  WidgetGrid,
  describeError,
  useToast,
} from '../../components';
import { useNow } from '../../lib/clock';
import { useLatest } from '../../lib/dom';
import { formatDuration, formatInteger } from '../../lib/format';
import { useProjects } from '../changes/projects';
import { AnchorsPanel } from './Anchors';
import { ErasureForm, ErasureHistory } from './Erasure';
import { SelfModBlocks } from './SelfMod';
import { EventDrawer } from './EventDrawer';
import { Explorer, type ExplorerFilters } from './Explorer';
import { ChainBar, VerifyResult, type LastVerification } from './Integrity';
import { EVENT_FAMILIES, RANGE_OPTIONS, chainCoverage, healthWarningText, type RangePreset } from './model';
import { PeopleProvider, usePeople } from './people';
import { can } from './permissions';
import { LoadFailed, Skeleton } from './Skeleton';
import './audit.css';

const isIntegrityEvent = (m: StreamMessage) =>
  m.kind === 'aoc' &&
  (m.event.type.startsWith('anchor.') ||
    m.event.type === 'chain.verified' ||
    m.event.type === 'selfmod.blocked' ||
    m.event.type === 'body.erased' ||
    m.event.type === 'config.changed');
const isAnchorEvent = (m: StreamMessage) => m.kind === 'aoc' && m.event.type.startsWith('anchor.');
const typeIs = (type: string) => (m: StreamMessage) => m.kind === 'aoc' && m.event.type === type;

const RANGES = new Set(RANGE_OPTIONS.map((r) => r.value));

/** A text filter that commits to the URL 350 ms after typing stops (one query per pause, not per keystroke). */
function DebouncedField({
  label,
  value,
  onCommit,
  placeholder,
  list,
  className,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  list?: string;
  className?: string;
}) {
  const [text, setText] = useState(value);
  const commit = useLatest(onCommit);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (text === value) return undefined;
    const t = setTimeout(() => commit.current(text.trim()), 350);
    return () => clearTimeout(t);
  }, [text, value, commit]);
  return (
    <TextField
      label={label}
      fieldClassName={className}
      value={text}
      list={list}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit.current(text.trim());
      }}
    />
  );
}

function AuditView() {
  const { user } = useAuth();
  const toast = useToast();
  const now = useNow();
  const projects = useProjects();
  const { people } = usePeople();
  const [params, setParams] = useSearchParams();
  const health = useResource<AuditHealthDTO>('/api/audit/health', { refreshOn: isIntegrityEvent });
  const anchors = useResource<AnchorListDTO>('/api/audit/anchors', { refreshOn: isAnchorEvent });
  const lastVerify = useResource<AuditEventPageDTO>('/api/audit/events', {
    query: { type: 'chain.verified', order: 'desc', limit: 1 },
    refreshOn: typeIs('chain.verified'),
  });
  const selfmod = useResource<AuditEventPageDTO>('/api/audit/events', {
    query: { type: 'selfmod.blocked', order: 'desc', limit: 200 },
    refreshOn: typeIs('selfmod.blocked'),
  });
  const erasures = useResource<AuditEventPageDTO>('/api/audit/events', {
    query: { type: 'body.erased', order: 'desc', limit: 100 },
    refreshOn: typeIs('body.erased'),
  });
  const [report, setReport] = useState<VerifyReportDTO | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [anchoring, setAnchoring] = useState(false);
  const [actionError, setActionError] = useState<{ what: string; error: unknown } | null>(null);

  const canVerify = can(user, 'audit.verify');
  const canErase = can(user, 'audit.erase');

  const range = (RANGES.has(params.get('range') as RangePreset) ? params.get('range') : '7d') as RangePreset;
  const filters: ExplorerFilters = useMemo(
    () => ({
      q: params.get('prefix') ?? params.get('type') ?? '',
      actorId: params.get('actor') ?? '',
      projectId: params.get('project') ?? '',
      scopeId: params.get('scope') ?? '',
      range,
    }),
    [params, range],
  );
  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params);
      if (key === 'prefix') next.delete('type');
      if (value) next.set(key, value);
      else next.delete(key);
      setParams(next, { replace: true });
    },
    [params, setParams],
  );
  const openSeq = Number(params.get('seq')) || null;
  const openEvent = useCallback((e: AuditEventHeaderDTO) => setParam('seq', String(e.seq)), [setParam]);

  const verify = async () => {
    setVerifying(true);
    setActionError(null);
    try {
      setReport(await apiGet<VerifyReportDTO>('/api/audit/verify'));
    } catch (error) {
      setActionError({ what: 'Verify', error });
    } finally {
      setVerifying(false);
    }
  };
  const anchorNow = async () => {
    setAnchoring(true);
    setActionError(null);
    try {
      const r = await apiPost<AnchorResultDTO>('/api/audit/anchor');
      toast.notify(
        r.pushError
          ? {
              tone: 'warn',
              title: `Anchored #${formatInteger(r.anchor.seq)} locally`,
              body: `Not pushed off-host: ${r.pushError}`,
            }
          : { tone: 'ok', title: `Anchored the chain head #${formatInteger(r.anchor.seq)}` },
      );
    } catch (error) {
      setActionError({ what: 'Anchor', error });
    } finally {
      setAnchoring(false);
    }
  };

  const last = lastVerify.data?.events[0];
  const lastVerification: LastVerification | null = last
    ? {
        at: last.ts,
        ok: last.meta.ok === true,
        actor: last.actor,
        checked: typeof last.meta.checked === 'number' ? last.meta.checked : null,
        anchorsChecked: typeof last.meta.anchorsChecked === 'number' ? last.meta.anchorsChecked : null,
        anchorsMatched: typeof last.meta.anchorsMatched === 'number' ? last.meta.anchorsMatched : null,
      }
    : null;

  const typeOptions = EVENT_FAMILIES.map((f) => <option key={f} value={f} />);

  return (
    <>
      <PageHeader
        title="Audit"
        subtitle="One append-only, hash-chained log for the CEO and the auditor alike (§13)."
        actions={
          canVerify ? (
            <>
              <Button
                icon="key"
                loading={anchoring}
                loadingText="Anchoring…"
                onClick={() => void anchorNow()}
              >
                Anchor now
              </Button>
              <Button
                variant="primary"
                icon="audit"
                loading={verifying}
                loadingText="Verifying…"
                onClick={() => void verify()}
              >
                Verify against anchors
              </Button>
            </>
          ) : undefined
        }
      />
      {actionError && (
        <InlineAlert
          tone="danger"
          title={`${actionError.what} did not complete`}
          live
          onDismiss={() => setActionError(null)}
        >
          {describeError(actionError.error)}
        </InlineAlert>
      )}
      <WidgetGrid>
        <Widget
          span={12}
          title="Is the log intact?"
          subtitle="only verification against an external anchor proves it"
          info="Every event's hash covers its header and the previous hash. The in-file chain alone is defeatable by anyone who can rewrite the file and recompute it, so Verify recomputes the chain and checks it against every off-host anchor (git commit or RFC 3161 timestamp). Events after the last anchor are not protected yet."
        >
          {!health.data || !anchors.data ? (
            health.error || anchors.error ? (
              <LoadFailed
                what="chain integrity"
                error={health.error ?? anchors.error}
                onRetry={() => {
                  health.reload();
                  anchors.reload();
                }}
              />
            ) : (
              <Skeleton label="Loading chain integrity" blocks={[96, 64]} />
            )
          ) : (
            <div className="audit-integrity">
              <ChainBar coverage={chainCoverage(health.data.headSeq, anchors.data.anchors)} />
              <VerifyResult
                report={report}
                offHost={anchors.data.offHost}
                last={lastVerification}
                health={health.data}
              />
              <p className="audit-note">
                <Icon name="info" size={14} />
                <span>
                  <strong>Only verify-against-anchor proves integrity.</strong> A matching in-file chain on
                  its own proves nothing: whoever can drop the trigger can recompute it (§13, R2).
                </span>
              </p>
            </div>
          )}
        </Widget>

        <Widget
          span={7}
          title="Off-host anchors"
          subtitle="the chain head copied where this host cannot rewrite it"
          info="The nightly job anchors the chain head; Anchor now anchors it immediately. The console warns when the last anchor is older than 26 hours."
        >
          {health.data && anchors.data ? (
            <AnchorsPanel anchors={anchors.data} health={health.data} now={now} />
          ) : (
            <Skeleton label="Loading anchors" blocks={[160]} />
          )}
        </Widget>

        <Widget
          span={5}
          title="Self-modification blocks"
          subtitle="agents stopped at the governance core"
          info="The platform may build its own features but never its own governance, audit or credit core, nor touch AOC's audit state (§13). Each blocked attempt is recorded here and in a log outside AOC. Approvers can open an event to see the path."
        >
          {selfmod.data && health.data ? (
            <SelfModBlocks
              events={selfmod.data.events}
              total={health.data.selfmodBlocked.total}
              last24h={health.data.selfmodBlocked.last24h}
              onOpen={openEvent}
            />
          ) : selfmod.error ? (
            <LoadFailed what="self-modification blocks" error={selfmod.error} onRetry={selfmod.reload} />
          ) : (
            <Skeleton label="Loading self-modification blocks" blocks={[140]} />
          )}
        </Widget>
      </WidgetGrid>

      <section className="audit-section" aria-label="Event explorer">
        <FilterBar label="Event filters">
          <SegmentedControl
            label="Time range"
            value={range}
            onChange={(v) => setParam('range', v === '7d' ? null : v)}
            options={RANGE_OPTIONS}
          />
          <DebouncedField
            label="Event type"
            className="audit-filter audit-filter--type"
            value={filters.q}
            list="audit-event-families"
            placeholder="change. or change.submitted"
            onCommit={(v) => setParam('prefix', v || null)}
          />
          <datalist id="audit-event-families">{typeOptions}</datalist>
          <Select
            label="Actor"
            fieldClassName="audit-filter"
            value={filters.actorId}
            onChange={(e) => setParam('actor', e.target.value || null)}
            options={[
              { value: '', label: 'Anyone' },
              ...people.map((p) => ({ value: p.id, label: p.name })),
              { value: 'change', label: 'System · change control' },
              { value: 'supervisor', label: 'System · supervisor' },
              { value: 'scheduler:audit', label: 'System · audit scheduler' },
            ]}
          />
          <Select
            label="Project"
            fieldClassName="audit-filter"
            value={filters.projectId}
            onChange={(e) => setParam('project', e.target.value || null)}
            options={[
              { value: '', label: 'All projects' },
              ...projects.projects.map((p) => ({ value: p.projectId, label: p.name })),
            ]}
          />
          <DebouncedField
            label="Session or ticket id"
            className="audit-filter"
            value={filters.scopeId}
            placeholder="ses_… or tkt_…"
            onCommit={(v) => setParam('scope', v || null)}
          />
        </FilterBar>
        <WidgetGrid>
          <Widget
            span={12}
            flush
            title="Event explorer"
            subtitle="newest first · seq, hash and previous hash for every event; bodies for Approvers only"
          >
            <Explorer filters={filters} now={now} onOpen={openEvent} />
          </Widget>
        </WidgetGrid>
      </section>

      <WidgetGrid>
        <Widget
          span={7}
          title="Erasure (crypto-shred)"
          subtitle={canErase ? 'Approver only · needs a resolved decision' : 'Approver only'}
          info="Bodies (file contents, personal data, captures) live in a per-scope encrypted store; only their blinded hashes are chained. Destroying a scope's key erases its bodies while the chain stays valid (§13, PDPA)."
        >
          {canErase ? (
            <ErasureForm onErased={() => erasures.reload()} />
          ) : (
            <InlineAlert tone="info" title="Erasure needs the Approver">
              Only an Approver can crypto-shred a scope, against a resolved decision. Every erasure is listed
              here for everyone.
            </InlineAlert>
          )}
          <h3 className="audit-subtitle">Erasures</h3>
          {erasures.data ? (
            <ErasureHistory events={erasures.data.events} />
          ) : erasures.error ? (
            <LoadFailed what="erasures" error={erasures.error} onRetry={erasures.reload} />
          ) : (
            <Skeleton label="Loading erasures" blocks={[80]} />
          )}
        </Widget>
        <Widget span={5} title="Projections, reactors and jobs" subtitle="what keeps the views honest">
          {health.data ? (
            <ul className="audit-health">
              <li>
                <Icon
                  name={health.data.projections.some((p) => p.status !== 'ok') ? 'warn' : 'ok'}
                  size={14}
                  className={
                    health.data.projections.some((p) => p.status !== 'ok')
                      ? 'aoc-tone-text--warn'
                      : 'aoc-tone-text--ok'
                  }
                />
                <span>
                  {health.data.projections.filter((p) => p.status !== 'ok').length === 0
                    ? 'Every projection is current'
                    : `${health.data.projections.filter((p) => p.status !== 'ok').length} projections degraded: ${health.data.projections
                        .filter((p) => p.status !== 'ok')
                        .map((p) => p.name)
                        .join(', ')}`}
                </span>
              </li>
              <li>
                <Icon
                  name={health.data.reactorFailures.total ? 'warn' : 'ok'}
                  size={14}
                  className={health.data.reactorFailures.total ? 'aoc-tone-text--warn' : 'aoc-tone-text--ok'}
                />
                <span>
                  {formatInteger(health.data.reactorFailures.total)} reactor{' '}
                  {health.data.reactorFailures.total === 1 ? 'failure' : 'failures'} recorded
                </span>
              </li>
              {health.data.jobs
                .filter(
                  (j) =>
                    j.name.startsWith('audit.') ||
                    j.name.startsWith('change.') ||
                    j.name.startsWith('evidence.'),
                )
                .map((j) => (
                  <li key={j.name}>
                    <Icon
                      name={j.lastStatus === 'ok' ? 'ok' : j.lastStatus ? 'danger' : 'clock'}
                      size={14}
                      className={
                        j.lastStatus === 'ok'
                          ? 'aoc-tone-text--ok'
                          : j.lastStatus
                            ? 'aoc-tone-text--danger'
                            : undefined
                      }
                    />
                    <span>
                      <code>{j.name}</code>{' '}
                      {j.lastRunAt
                        ? `ran ${formatDuration(now - Date.parse(j.lastRunAt))} ago (${j.lastStatus ?? 'unknown'})`
                        : 'has not run yet'}
                      {j.lastError ? ` — ${j.lastError}` : ''}
                    </span>
                  </li>
                ))}
              {health.data.warnings.map((w) => (
                <li key={w}>
                  <Icon name="warn" size={14} className="aoc-tone-text--warn" />
                  <span>{healthWarningText(w)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Skeleton label="Loading health" blocks={[120]} />
          )}
        </Widget>
      </WidgetGrid>

      <EventDrawer
        seq={openSeq}
        headSeq={health.data?.headSeq ?? null}
        onClose={() => setParam('seq', null)}
        onOpenSeq={(s) => setParam('seq', String(s))}
      />
    </>
  );
}

export default function AuditPage() {
  return (
    <PeopleProvider>
      <AuditView />
    </PeopleProvider>
  );
}

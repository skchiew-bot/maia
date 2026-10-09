import { useMemo, useState } from 'react';
import type { PinDTO, PinListDTO } from '@aoc/contracts';
import type { StreamMessage } from '../../api/stream';
import { useResource } from '../../api/useResource';
import {
  Badge,
  Button,
  Checkbox,
  CopyableHash,
  DataTable,
  EmptyState,
  RelativeTime,
  type DataTableColumn,
} from '../../components';
import { formatInteger } from '../../lib/format';
import { LoadFailed, Skeleton } from '../audit/Skeleton';
import { PIN_PROBLEM_TEXT, pinRef, pinSourceText } from '../changes/RollbackTargetPicker';

export const isPinEvent = (m: StreamMessage) =>
  m.kind === 'aoc' &&
  ['git.ref_pinned', 'phase.completed', 'change.submitted', 'change.completed'].includes(m.event.type);

const latest = (p: PinDTO) => p.pinnedBy[p.pinnedBy.length - 1]!;

export interface PinsPanelProps {
  projectId: string;
  canRequest: boolean;
  onRollback: (target: string, changeId: string | null) => void;
}

/** Pinned states of one project (phase completions, change records), each checked against the repository. */
export function PinsPanel({ projectId, canRequest, onRollback }: PinsPanelProps) {
  const pins = useResource<PinListDTO>('/api/pins', {
    query: { projectId, limit: 300 },
    refreshOn: isPinEvent,
  });
  const [showBroken, setShowBroken] = useState(false);
  const data = pins.data;
  const broken = data?.pins.filter((p) => p.problem).length ?? 0;
  const rows = useMemo(() => (data?.pins ?? []).filter((p) => showBroken || !p.problem), [data, showBroken]);

  const columns = useMemo<DataTableColumn<PinDTO>[]>(
    () => [
      {
        id: 'state',
        header: 'Pinned state',
        primary: true,
        cell: (p) => (
          <span className="rollbacks-pin">
            {p.tag ? (
              <code className="rollbacks-pin__tag">{p.tag}</code>
            ) : (
              <span className="rollbacks-muted">commit</span>
            )}
            {(p.resolvedSha ?? p.sha) && (
              <CopyableHash value={(p.resolvedSha ?? p.sha)!} label={`${p.tag ?? 'pinned'} commit`} />
            )}
          </span>
        ),
      },
      {
        id: 'source',
        header: 'Pinned by',
        cell: (p) => (
          <span>
            {pinSourceText(p)}
            {p.pinnedBy.length > 1 && (
              <span className="rollbacks-muted"> · {formatInteger(p.pinnedBy.length)} records</span>
            )}
          </span>
        ),
      },
      {
        id: 'when',
        header: 'When',
        numeric: true,
        sortValue: (p) => latest(p).seq,
        cell: (p) => <RelativeTime value={latest(p).at} suffix=" ago" />,
      },
      {
        id: 'restorable',
        header: 'Restorable',
        cell: (p) =>
          p.problem ? (
            <Badge tone="warn" icon="warn" variant="outline">
              {PIN_PROBLEM_TEXT[p.problem]}
            </Badge>
          ) : (
            <Badge tone="ok" icon="ok" variant="outline">
              resolves
            </Badge>
          ),
      },
      {
        id: 'action',
        header: 'Action',
        hideHeader: true,
        align: 'end',
        cell: (p) => {
          const change = p.pinnedBy.find((b) => b.source.startsWith('change.'))?.sourceId ?? null;
          return (
            <Button
              size="sm"
              icon="rollbacks"
              disabled={!!p.problem || !canRequest}
              title={
                p.problem
                  ? `Cannot roll back: ${PIN_PROBLEM_TEXT[p.problem]}`
                  : !canRequest
                    ? 'Your role cannot request rollbacks'
                    : undefined
              }
              onClick={() => onRollback(pinRef(p), change)}
            >
              Roll back…
            </Button>
          );
        },
      },
    ],
    [canRequest, onRollback],
  );

  if (!data) {
    if (pins.error) return <LoadFailed what="pinned states" error={pins.error} onRetry={pins.reload} />;
    return <Skeleton label="Loading pinned states" blocks={[180]} />;
  }
  return (
    <div className="rollbacks-pins">
      <div className="rollbacks-pins__head">
        <span>
          {data.defaultBranch ?? 'main'} is at{' '}
          {data.head ? <CopyableHash value={data.head} label="default branch head" /> : 'an unknown commit'}
        </span>
        {broken > 0 && (
          <Checkbox
            label={`Show ${formatInteger(broken)} pinned ${broken === 1 ? 'state' : 'states'} that no longer resolve`}
            checked={showBroken}
            onChange={(e) => setShowBroken(e.target.checked)}
          />
        )}
      </div>
      <DataTable
        caption="Pinned states"
        columns={columns}
        rows={rows}
        rowKey={(p) => `${p.tag ?? ''}:${p.sha ?? ''}`}
        maxHeight={420}
        empty={
          <EmptyState
            size="sm"
            icon="rollbacks"
            title={broken ? 'No pinned state resolves in the repository' : 'Nothing pinned yet'}
            body="Phase completions and completed change records pin an immutable tag or SHA; those are the states a rollback can return to."
          />
        }
      />
    </div>
  );
}

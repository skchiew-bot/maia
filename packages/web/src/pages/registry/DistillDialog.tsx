import { useEffect, useId, useMemo, useState } from 'react';
import type { RegistryEntry, RegistryRunDTO } from '@aoc/contracts';
import { Button, Dialog, EmptyState, InlineAlert, describeError } from '../../components';
import { formatDuration, formatShortDate, formatTokens } from '../../lib/format';
import { distillCandidates, formatRunCost, modelLabel } from './registryModel';

export interface DistillDialogProps {
  open: boolean;
  onClose: () => void;
  runs: readonly RegistryRunDTO[];
  entries: readonly RegistryEntry[];
  /** Run to preselect (from a run row's Distill action). */
  initialRunId?: string | null;
  onDistill: (sessionId: string) => Promise<void>;
}

/** What approving a playbook for this type would change — said before anyone proposes one. */
function consequence(e: RegistryEntry | undefined): string {
  if (!e) return 'This process type is no longer in the registry.';
  if (e.class === 'discovery')
    return `${e.name} is discovery-class: it stays on ${modelLabel(e.model)}; the playbook guides runs but does not change routing.`;
  if (!e.executionModel || e.executionModel === e.model)
    return `${e.name} has no cheaper execution model; the playbook guides runs only.`;
  if (e.playbook.status === 'approved')
    return `Approval supersedes playbook v${e.playbook.activeVersion}; ${e.name} keeps running on ${modelLabel(e.executionModel)}.`;
  return `Once the Approver approves it, new ${e.name} runs launch on ${modelLabel(e.executionModel)} instead of ${modelLabel(e.model)}.`;
}

/**
 * Propose a playbook from a completed run (`POST /api/playbooks/distill`). The proposal is a
 * playbook_approval decision for the Approver; nothing routes differently until it is approved.
 */
export function DistillDialog({ open, onClose, runs, entries, initialRunId, onDistill }: DistillDialogProps) {
  const candidates = useMemo(() => distillCandidates(runs), [runs]);
  const [selected, setSelected] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groupId = useId();

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSelected(initialRunId ?? candidates[0]?.runId ?? null);
    // Only when the dialog opens: later candidate refreshes must not move the user's choice.
  }, [open, initialRunId]);

  const entryOf = (t: string) => entries.find((e) => e.processType === t);
  const run = candidates.find((r) => r.runId === selected) ?? null;
  const pending = run ? entryOf(run.processType)?.playbook.status === 'proposed' : false;

  const submit = async () => {
    if (!run) return;
    setSubmitting(true);
    setError(null);
    try {
      await onDistill(run.lastSessionId);
      onClose();
    } catch (err) {
      setError(describeError(err) ?? 'The playbook could not be distilled.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      dismissOnBackdrop={false}
      title="Distill a playbook from a run"
      description="Only a completed run with every declared task done can be distilled. The proposal goes to the Approver as a decision."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!run}
            loading={submitting}
            loadingText="Distilling…"
            onClick={() => void submit()}
          >
            Propose playbook
          </Button>
        </>
      }
    >
      {candidates.length === 0 ? (
        <EmptyState
          size="sm"
          icon="registry"
          title="No completed run to distill"
          body="Runs appear here when they finish with outcome completed and have not already produced a playbook."
        />
      ) : (
        <fieldset className="reg-distill">
          <legend className="aoc-sr-only">Completed runs</legend>
          <ul className="reg-distill__list" role="list">
            {candidates.map((r) => {
              const e = entryOf(r.processType);
              const id = `${groupId}-${r.runId}`;
              return (
                <li key={r.runId}>
                  <input
                    type="radio"
                    id={id}
                    name={groupId}
                    value={r.runId}
                    checked={selected === r.runId}
                    onChange={() => setSelected(r.runId)}
                  />
                  <label htmlFor={id}>
                    <b>{e?.name ?? r.processType}</b>
                    <span className="reg-sub aoc-num">
                      {formatShortDate(r.launchedAt)} · {r.durationMs !== null ? formatDuration(r.durationMs) : '—'} ·{' '}
                      {formatRunCost(r.costUsd)} · {formatTokens(r.tokens)} tokens · {modelLabel(r.model)} ·{' '}
                      <code>{r.lastSessionId}</code>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}
      {run && (
        <InlineAlert tone={pending ? 'warn' : 'info'} title={pending ? 'A proposal is already waiting' : 'What approval changes'}>
          {pending
            ? `${entryOf(run.processType)?.name ?? run.processType} already has a playbook awaiting the Approver; the daemon refuses a second proposal until it is decided.`
            : consequence(entryOf(run.processType))}
        </InlineAlert>
      )}
      {error && (
        <InlineAlert tone="danger" title="Not distilled" live>
          {error}
        </InlineAlert>
      )}
    </Dialog>
  );
}

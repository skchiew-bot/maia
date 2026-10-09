import type { ProcessTypeView, RegistryEntry, RegistryTypesResponse } from '@aoc/contracts';
import { CopyableHash, DataTable, Icon, Widget, type DataTableColumn } from '../../components';
import { formatInteger, formatTokens } from '../../lib/format';
import { modelLabel, routingReason } from './registryModel';

const CLASS_LABEL: Record<string, string> = {
  discovery: 'Discovery class',
  execution: 'Execution class',
  triage: 'Triage class',
  maintenance: 'Maintenance class',
};

const PERMISSION_LABEL: Record<string, string> = {
  acceptEdits: 'accepts edits',
  dontAsk: 'never prompts (deny list enforced)',
  bypassPermissions: 'bypasses permission prompts',
  default: 'default prompts',
  plan: 'plan mode only',
};

function tools(t: ProcessTypeView): string {
  if (t.builtinTools?.length) return `Only ${t.builtinTools.join(', ')}`;
  const parts: string[] = [];
  if (t.tools.allow?.length) parts.push(`allows ${t.tools.allow.join(', ')}`);
  if (t.tools.deny?.length) parts.push(`denies ${t.tools.deny.join(', ')}`);
  return parts.length ? parts.join('; ') : 'Default tool set';
}

function guards(t: ProcessTypeView): string[] {
  const out: string[] = [];
  if (t.requiresPlan) out.push('Plan manifest required');
  out.push(
    t.risky
      ? `Never rolls over mid-operation (rollover at ${t.rolloverContextPct}% context, clean boundaries only)`
      : `Rollover at ${t.rolloverContextPct}% context, at a clean task boundary`,
  );
  if (t.diagnosisBudget)
    out.push(
      `Diagnosis budget ${formatTokens(t.diagnosisBudget.tokens)} tokens / ${formatInteger(t.diagnosisBudget.minutes)} min`,
    );
  if (t.stallAfterMs) out.push(`Stalled after ${Math.round(t.stallAfterMs / 60_000)} min without progress`);
  out.push(`Permissions: ${PERMISSION_LABEL[t.permissionMode] ?? t.permissionMode}`);
  return out;
}

export interface RoutingPanelProps {
  types: RegistryTypesResponse;
  entries: readonly RegistryEntry[];
}

/** Model routing (§2.2, §10): the type fixes the model at launch; discovery stays on Opus whatever the budget. */
export function RoutingPanel({ types, entries }: RoutingPanelProps) {
  const activeVersion = (id: string) => entries.find((e) => e.processType === id)?.playbook.activeVersion ?? null;
  const columns: DataTableColumn<ProcessTypeView>[] = [
    {
      id: 'type',
      header: 'Process type',
      primary: true,
      cell: (t) => (
        <span className="reg-rt__type">
          <b>{t.name}</b>
          <code>{t.id}</code>
          <span className="reg-sub">{CLASS_LABEL[t.class] ?? t.class}</span>
        </span>
      ),
    },
    {
      id: 'discovery',
      header: 'Discovery',
      cell: (t) =>
        t.class === 'discovery' ? (
          <span className="reg-locked" title="Discovery-class: credits and budget can never change this model">
            <Icon name="compliance" size={12} />
            {modelLabel(t.model)}
            <span className="aoc-sr-only"> (locked)</span>
          </span>
        ) : (
          modelLabel(t.model)
        ),
    },
    {
      id: 'execution',
      header: 'Execution',
      cell: (t) =>
        t.class !== 'discovery' && t.executionModel && t.executionModel !== t.model ? (
          <span>
            {modelLabel(t.executionModel)}
            <span className="reg-sub"> once a playbook is approved</span>
          </span>
        ) : (
          <span className="reg-muted">—</span>
        ),
    },
    {
      id: 'now',
      header: 'Launches on now',
      cell: (t) => (
        <span className="reg-rt__now">
          <b>{modelLabel(t.currentModel)}</b>
          <span className="reg-sub">{routingReason(t, activeVersion(t.id))}</span>
        </span>
      ),
    },
    {
      id: 'access',
      header: 'Access',
      cell: (t) =>
        t.readOnly ? (
          <span className="reg-chip">
            <Icon name="eye" size={12} />
            Read-only · no credentials
          </span>
        ) : t.credentialProfile ? (
          <span>
            <code>{t.credentialProfile}</code>
            <span className="reg-sub"> credentials, supervisor session env only</span>
          </span>
        ) : (
          <span className="reg-muted">No credentials</span>
        ),
    },
    { id: 'tools', header: 'Allowed tools', cell: (t) => <span className="reg-rt__tools">{tools(t)}</span> },
    {
      id: 'guards',
      header: 'Guards',
      cell: (t) => (
        <ul className="reg-rt__guards">
          {guards(t).map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      ),
    },
  ];
  return (
    <Widget
      span={12}
      id="routing"
      title="Model routing"
      subtitle={
        <>
          The type is declared at launch (<code>aoc run --type</code>) from this fixed list; the model is fixed for
          the session
        </>
      }
      flush
      footer={
        <>
          <span>
            Registry {types.version} · <CopyableHash value={types.versionHash} label="registry version hash" />
          </span>
          <span>Changes to this list are audited (registry.changed)</span>
        </>
      }
    >
      <p className="reg-rule">
        <Icon name="compliance" size={14} />
        <span>
          <b>Discovery always runs on Opus.</b> Credits meter cost; they never pick the model, and budget never
          overrides this rule.
        </span>
      </p>
      <DataTable
        caption="Model routing per process type"
        columns={columns}
        rows={types.types}
        rowKey={(t) => t.id}
      />
    </Widget>
  );
}

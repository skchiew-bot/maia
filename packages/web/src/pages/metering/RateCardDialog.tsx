import { useEffect, useState } from 'react';
import type { RateCardRate, RateCardVersionDTO } from '@aoc/contracts';
import { Button, Dialog, IconButton, InlineAlert, TextArea, TextField, describeError } from '../../components';
import { dayLabel } from './meteringModel';

export interface RateCardDraft {
  rates: RateCardRate[];
  effectiveFrom: string;
  note?: string;
}

export interface RateCardDialogProps {
  open: boolean;
  onClose: () => void;
  /** Latest version (active or scheduled): the starting point of the new one. */
  base: RateCardVersionDTO | null;
  earliestEffectiveFrom: string;
  onPublish: (draft: RateCardDraft) => Promise<RateCardVersionDTO>;
}

const FIELDS = [
  ['inputPerMTok', 'Input'],
  ['outputPerMTok', 'Output'],
  ['cacheReadPerMTok', 'Cache read'],
  ['cacheWrite5mPerMTok', 'Cache write 5m'],
  ['cacheWrite1hPerMTok', 'Cache write 1h'],
] as const;
type PriceField = (typeof FIELDS)[number][0];

export interface RateRow {
  key: number;
  model: string;
  prices: Record<PriceField, string>;
}

const toRow = (r: RateCardRate, key: number): RateRow => ({
  key,
  model: r.model,
  prices: Object.fromEntries(FIELDS.map(([f]) => [f, String(r[f])])) as Record<PriceField, string>,
});

/** Validates the draft the way the daemon will (unique models, non-negative prices, forward-only date). */
export function validateDraft(rows: readonly RateRow[], effectiveFrom: string, earliest: string): string | null {
  if (rows.length === 0) return 'Add at least one model.';
  const seen = new Set<string>();
  for (const r of rows) {
    const id = r.model.trim().toLowerCase();
    if (!id) return 'Every row needs a model id.';
    if (seen.has(id)) return `${r.model.trim()} appears twice.`;
    seen.add(id);
    for (const [f, label] of FIELDS) {
      const v = Number(r.prices[f]);
      if (r.prices[f].trim() === '' || !Number.isFinite(v) || v < 0)
        return `${label} for ${r.model.trim()} must be a price of 0 or more.`;
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) return 'Choose the day the new prices take effect.';
  if (effectiveFrom < earliest) return `Rate changes apply forward only: choose ${dayLabel(earliest)} or later.`;
  return null;
}

/** Schedule a new immutable rate-card version (Approver). Prices apply from `effectiveFrom`, never backwards. */
export function RateCardDialog({ open, onClose, base, earliestEffectiveFrom, onPublish }: RateCardDialogProps) {
  const [rows, setRows] = useState<RateRow[]>([]);
  const [effectiveFrom, setEffectiveFrom] = useState(earliestEffectiveFrom);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [nextKey, setNextKey] = useState(0);

  useEffect(() => {
    if (!open) return;
    const start = base?.rates ?? [];
    setRows(start.map(toRow));
    setNextKey(start.length);
    setEffectiveFrom(earliestEffectiveFrom);
    setNote('');
    setError(null);
  }, [open, base, earliestEffectiveFrom]);

  const update = (key: number, patch: Partial<RateRow>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const submit = async () => {
    const problem = validateDraft(rows, effectiveFrom, earliestEffectiveFrom);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onPublish({
        effectiveFrom,
        note: note.trim() || undefined,
        rates: rows.map((r) => ({
          model: r.model.trim(),
          ...(Object.fromEntries(FIELDS.map(([f]) => [f, Number(r.prices[f])])) as Record<PriceField, number>),
        })),
      });
      onClose();
    } catch (err) {
      setError(describeError(err) ?? 'The rate card was not published.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      dismissOnBackdrop={false}
      title="Schedule a new rate-card version"
      description={`Prices in US$ per million tokens. The version takes effect on the day you choose (${dayLabel(
        earliestEffectiveFrom,
      )} at the earliest) and never changes a closed day.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} loadingText="Publishing…" onClick={() => void submit()}>
            Publish version
          </Button>
        </>
      }
    >
      <div className="met-form">
        <TextField
          label="Effective from"
          type="date"
          required
          min={earliestEffectiveFrom}
          value={effectiveFrom}
          onChange={(e) => setEffectiveFrom(e.target.value)}
          hint={`Forward only: ${dayLabel(earliestEffectiveFrom)} or later.`}
        />
        <div className="met-scroll">
          <table className="met-rates met-rates--edit">
            <caption className="aoc-sr-only">New rates, US dollars per million tokens</caption>
            <thead>
              <tr>
                <th scope="col">Model id</th>
                {FIELDS.map(([f, label]) => (
                  <th key={f} scope="col" className="is-end">
                    {label}
                  </th>
                ))}
                <th scope="col">
                  <span className="aoc-sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>
                    <input
                      className="aoc-input met-input-model"
                      aria-label="Model id"
                      value={r.model}
                      onChange={(e) => update(r.key, { model: e.target.value })}
                    />
                  </td>
                  {FIELDS.map(([f, label]) => (
                    <td key={f}>
                      <input
                        className="aoc-input met-input-price aoc-num"
                        inputMode="decimal"
                        aria-label={`${label} price for ${r.model || 'new model'}`}
                        value={r.prices[f]}
                        onChange={(e) => update(r.key, { prices: { ...r.prices, [f]: e.target.value } })}
                      />
                    </td>
                  ))}
                  <td>
                    <IconButton
                      icon="close"
                      size="sm"
                      label={`Remove ${r.model || 'row'}`}
                      onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <Button
            size="sm"
            icon="plus"
            onClick={() => {
              setRows((rs) => [
                ...rs,
                { key: nextKey, model: '', prices: { inputPerMTok: '', outputPerMTok: '', cacheReadPerMTok: '', cacheWrite5mPerMTok: '', cacheWrite1hPerMTok: '' } },
              ]);
              setNextKey((k) => k + 1);
            }}
          >
            Add a model
          </Button>
        </div>
        <TextArea
          label="Note (optional)"
          rows={2}
          maxLength={2000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          hint="Why the prices change; stored in the encrypted body, not in the chained metadata."
        />
        {error && (
          <InlineAlert tone="danger" title="Not published" live>
            {error}
          </InlineAlert>
        )}
      </div>
    </Dialog>
  );
}

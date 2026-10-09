import { createHash } from 'node:crypto';

/**
 * Canonical JSON (RFC 8785-style): object keys sorted, no whitespace, `undefined` members dropped.
 * Hash inputs MUST go through this so the chain verifies byte-for-byte on any machine.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('non-finite number in canonical JSON');
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : sortDeep(x)));
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    const x = (v as Record<string, unknown>)[k];
    if (x !== undefined) out[k] = sortDeep(x);
  }
  return out;
}

export function sha256hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

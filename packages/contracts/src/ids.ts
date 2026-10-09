import { ID_PREFIX, type IdKind } from './domain';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ULID-style id: <prefix>_<26 chars> — time-sortable, URL-safe. Uses crypto.getRandomValues (node + browser). */
export function newId(kind: IdKind, now: number = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i]! % 32];
  return `${ID_PREFIX[kind]}_${time}${rand}`;
}

export function idKindOf(id: string): IdKind | null {
  const prefix = id.split('_')[0];
  for (const [k, v] of Object.entries(ID_PREFIX)) if (v === prefix) return k as IdKind;
  return null;
}

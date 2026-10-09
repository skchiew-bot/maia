import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { IDENTITY_TOKEN_PREFIX, type IdentityTokenKind } from '@aoc/contracts';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** 43 base62 chars ≈ 256 bits of entropy. */
export const TOKEN_BODY_LENGTH = 43;
/** Body chars kept in clear as the lookup/display prefix (~47 bits); the remaining ~208 bits stay secret. */
const PREFIX_BODY_CHARS = 8;
const KIND_BY_LETTER: Record<string, IdentityTokenKind> = {
  u: 'user',
  w: 'web_session',
  i: 'ingest_session',
  o: 'observer',
  s: 'system',
};
const TOKEN_RE = /^aoc_([uwios])_([0-9A-Za-z]{32,128})$/;

export function randomBase62(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      // 248 = 4 × 62: rejecting the top 8 byte values keeps every character equally likely.
      if (b < 248) out += BASE62[b % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

export function generateToken(kind: IdentityTokenKind): string {
  return IDENTITY_TOKEN_PREFIX[kind] + randomBase62(TOKEN_BODY_LENGTH);
}

export interface ParsedToken {
  kind: IdentityTokenKind;
  /** Non-secret lookup prefix, e.g. "aoc_u_7fK2mQ9a". */
  prefix: string;
}

export function parseToken(token: string): ParsedToken | null {
  if (token.length > 200) return null;
  const m = TOKEN_RE.exec(token);
  if (!m) return null;
  return { kind: KIND_BY_LETTER[m[1]!]!, prefix: `aoc_${m[1]}_${m[2]!.slice(0, PREFIX_BODY_CHARS)}` };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison of two sha256 hex digests. */
export function digestsEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b);
}

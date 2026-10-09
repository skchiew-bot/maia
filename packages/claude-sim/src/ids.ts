import { createHash } from 'node:crypto';

const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz123456789';

/**
 * Deterministic id source: every id is derived from (seed, counter), so a scenario replayed under the same
 * session id produces byte-identical ids (reproducible demo data). The counter is persisted with the sim
 * state so a resumed session never reuses an id.
 */
export class IdSource {
  constructor(
    private readonly seed: string,
    private counter = 0,
  ) {}

  get position(): number {
    return this.counter;
  }

  uuid(): string {
    const bytes = this.digest('uuid').subarray(0, 16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  messageId(): string {
    return `msg_01${this.token('msg', 22)}`;
  }

  requestId(): string {
    return `req_01${this.token('req', 22)}`;
  }

  toolUseId(): string {
    return `toolu_01${this.token('toolu', 22)}`;
  }

  /** Opaque base64 blob standing in for a thinking-block signature. */
  signature(): string {
    const parts: string[] = [];
    for (let i = 0; i < 6; i++) parts.push(this.digest('sig').toString('base64'));
    return parts.join('').replace(/=/g, '');
  }

  private token(kind: string, length: number): string {
    const digest = this.digest(kind);
    let out = '';
    for (let i = 0; i < length; i++)
      out += TOKEN_ALPHABET[digest[i % digest.length]! % TOKEN_ALPHABET.length];
    return out;
  }

  private digest(kind: string): Buffer {
    return createHash('sha256').update(`${this.seed}:${kind}:${this.counter++}`).digest();
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

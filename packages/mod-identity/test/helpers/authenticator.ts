import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array | string): Buffer => createHash('sha256').update(b).digest();

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

/** Minimal CBOR encoder (shortest-form heads): integers, byte/text strings, arrays and Maps. */
export function cbor(v: unknown): Buffer {
  if (typeof v === 'number' && Number.isInteger(v)) return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') {
    const s = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, s.length), s]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  if (v instanceof Map)
    return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error(`cbor: unsupported value ${String(v)}`);
}

export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export interface CeremonyOverrides {
  origin?: string;
  rpId?: string;
  flags?: number;
  challenge?: string;
  /** Assertion only: report this signature counter instead of incrementing. */
  counter?: number;
  userHandle?: string | null;
}

/**
 * Software platform authenticator: an ES256 (P-256) key pair from node:crypto, "none" attestation,
 * clientDataJSON / authenticatorData / DER signature built exactly as WebAuthn specifies.
 */
export class SoftAuthenticator {
  readonly credentialId = randomBytes(32);
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  counter = 0;
  private userHandle: string | null = null;

  constructor(
    readonly origin = 'http://localhost:7420',
    readonly rpId = 'localhost',
  ) {}

  get id(): string {
    return b64u(this.credentialId);
  }

  get publicKey(): KeyObject {
    return this.keys.publicKey;
  }

  coseKey(): Buffer {
    const jwk = this.keys.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    return cbor(
      new Map<number, unknown>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x, 'base64url')],
        [-3, Buffer.from(jwk.y, 'base64url')],
      ]),
    );
  }

  private authData(rpId: string, flags: number, counter: number, attested: boolean): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter, 0);
    const parts = [sha256(rpId), Buffer.from([flags | (attested ? FLAG_AT : 0)]), count];
    if (attested) {
      const idLen = Buffer.alloc(2);
      idLen.writeUInt16BE(this.credentialId.length, 0);
      parts.push(Buffer.alloc(16), idLen, this.credentialId, this.coseKey());
    }
    return Buffer.concat(parts);
  }

  /** navigator.credentials.create() → RegistrationResponseJSON. */
  register(
    options: { challenge: string; rp: { id?: string }; user: { id: string } },
    o: CeremonyOverrides = {},
  ) {
    this.userHandle = options.user.id;
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: 'webauthn.create',
        challenge: o.challenge ?? options.challenge,
        origin: o.origin ?? this.origin,
        crossOrigin: false,
      }),
    );
    const authData = this.authData(
      o.rpId ?? options.rp.id ?? this.rpId,
      o.flags ?? FLAG_UP | FLAG_UV,
      this.counter,
      true,
    );
    const attestationObject = cbor(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** navigator.credentials.get() → AuthenticationResponseJSON. */
  assert(options: { challenge: string; rpId?: string }, o: CeremonyOverrides = {}) {
    const counter = o.counter ?? ++this.counter;
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: o.challenge ?? options.challenge,
        origin: o.origin ?? this.origin,
        crossOrigin: false,
      }),
    );
    const authData = this.authData(
      o.rpId ?? options.rpId ?? this.rpId,
      o.flags ?? FLAG_UP | FLAG_UV,
      counter,
      false,
    );
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), this.keys.privateKey);
    const userHandle = o.userHandle === undefined ? this.userHandle : o.userHandle;
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        ...(userHandle ? { userHandle } : {}),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}

/**
 * A software WebAuthn authenticator for the seeder. Go-live, rollback and break-glass decisions need a per-decision
 * passkey (§6, §8) and nobody can touch a security key while a script writes history, so the seeder registers one
 * software authenticator for the CEO and signs the historical gates with it, through the same ceremony a browser
 * runs (`/api/passkeys/*`), so aocd verifies every signature cryptographically. The seeder removes the credential
 * when it is done: the demo ships no passkey the CEO does not hold, and registers a real one in Admin.
 *
 * ES256 key pair from node:crypto, "none" attestation, clientDataJSON / authenticatorData / DER signature built as the
 * WebAuthn specification describes.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

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

/** Minimal CBOR encoder (shortest-form heads): integers, byte and text strings, arrays and Maps. */
function cbor(v: unknown): Buffer {
  if (typeof v === 'number' && Number.isInteger(v)) return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') {
    const s = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, s.length), s]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error(`cbor: unsupported value ${String(v)}`);
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export class SoftAuthenticator {
  readonly credentialId = randomBytes(32);
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  private counter = 0;
  private userHandle: string | null = null;

  constructor(
    private readonly origin: string,
    private readonly rpId: string,
  ) {}

  get id(): string {
    return b64u(this.credentialId);
  }

  private coseKey(): Buffer {
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

  private authData(rpId: string, counter: number, attested: boolean): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter, 0);
    const parts = [sha256(rpId), Buffer.from([FLAG_UP | FLAG_UV | (attested ? FLAG_AT : 0)]), count];
    if (attested) {
      const idLen = Buffer.alloc(2);
      idLen.writeUInt16BE(this.credentialId.length, 0);
      parts.push(Buffer.alloc(16), idLen, this.credentialId, this.coseKey());
    }
    return Buffer.concat(parts);
  }

  /** navigator.credentials.create() → RegistrationResponseJSON. */
  register(options: { challenge: string; rp: { id?: string }; user: { id: string } }) {
    this.userHandle = options.user.id;
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: this.origin, crossOrigin: false }),
    );
    const authData = this.authData(options.rp.id ?? this.rpId, this.counter, true);
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
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal'] },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** navigator.credentials.get() → AuthenticationResponseJSON. */
  assert(options: { challenge: string; rpId?: string }) {
    const counter = ++this.counter;
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: this.origin, crossOrigin: false }),
    );
    const authData = this.authData(options.rpId ?? this.rpId, counter, false);
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), this.keys.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        ...(this.userHandle ? { userHandle: this.userHandle } : {}),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}

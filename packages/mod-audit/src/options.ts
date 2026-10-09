/** Minimal fetch surface used for the RFC 3161 TSA round-trip (global `fetch` satisfies it; tests inject a fake). */
export type TsaFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: Uint8Array; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

export interface AuditModuleOptions {
  /** TSA transport for the rfc3161 provider (default: global fetch). */
  tsaFetch?: TsaFetch;
  /**
   * Sign anchor commits: `git -c user.signingkey=<id> commit -S` (OpenPGP). Verify then requires valid signatures.
   * Overrides `audit.gpgKeyId`; the same holds for the three settings below and their `audit.*` keys.
   */
  gpgKeyId?: string;
  /** GNUPGHOME used when signing / verifying anchor commits (default: inherited environment). */
  gnupgHome?: string;
  /** CA bundle for `openssl ts -verify` of RFC 3161 tokens (without it only the token structure and imprint are checked). */
  tsaCaFile?: string;
  /** Intermediate certificates for `openssl ts -verify -untrusted`. */
  tsaUntrustedFile?: string;
  /** Max |TSA genTime − anchoredAt| accepted by verify (default 1h): a back-dated forgery cannot obtain an old timestamp. */
  tsaMaxSkewMs?: number;
  /** Where .json/.tsq/.tsr files of RFC 3161 anchors live (default `<dataDir>/anchors`). */
  tsrDir?: string;
  /** Governed ISO 42001 mapping file (default `config/iso42001-mapping.json`, hashed only if present). */
  mappingFile?: string;
  /** Extra attempts of the nightly anchor before it is recorded as failed (default 2). */
  anchorRetries?: number;
  /** Delay between nightly anchor attempts (default 30s). */
  retryDelayMs?: number;
  /** Anchor (and backup) age after which health warns (default 26h). */
  staleAfterMs?: number;
  /** A manual backup is refused when the last one is younger than this (default 10 min): repeated full copies fill disks. */
  minBackupIntervalMs?: number;
  /** Binaries (default from PATH). */
  gitBin?: string;
  opensslBin?: string;
}

export const DEFAULT_STALE_AFTER_MS = 26 * 60 * 60 * 1000;
export const DEFAULT_MIN_BACKUP_INTERVAL_MS = 10 * 60 * 1000;
export const DEFAULT_TSA_MAX_SKEW_MS = 60 * 60 * 1000;

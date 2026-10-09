import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256hex } from '@aoc/kernel';
import { parseAnchor, serializeAnchor, type AnchorRecord, type ExternalAnchor } from '../anchor-record';
import { brief, exec } from '../exec';
import type { TsaFetch } from '../options';
import {
  AnchorError,
  emptyListing,
  type AnchorProvider,
  type ChainAnchor,
  type CreatedAnchor,
  type ExternalListing,
  type ProofResult,
} from './provider';

export interface Rfc3161Config {
  /** Directory for <base>.json / .tsq / .tsr (null when the store is in-memory). */
  dir: string | null;
  tsaUrl: string;
  fetch: TsaFetch;
  opensslBin?: string;
  caFile?: string;
  untrustedFile?: string;
  maxSkewMs: number;
  timeoutMs?: number;
}

export interface TsReplyInfo {
  status: string | null;
  hashAlgorithm: string | null;
  /** Hex message imprint the TSA signed. */
  imprint: string | null;
  genTime: string | null;
  serial: string | null;
}

/** Parse `openssl ts -reply -in <tsr> -text`. */
export function parseTsReplyText(text: string): TsReplyInfo {
  const pick = (re: RegExp) => re.exec(text)?.[1]?.trim() ?? null;
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.startsWith('Message data:'));
  let imprint = '';
  for (let i = at + 1; at !== -1 && i < lines.length; i++) {
    const m = /^\s+[0-9a-f]{4} - ((?:[0-9a-f]{2}[ -]){0,15}[0-9a-f]{2})/.exec(lines[i]!);
    if (!m) break;
    imprint += m[1]!.replace(/[ -]/g, '');
  }
  const ts = pick(/^Time stamp:\s*(.+)$/m);
  const genMs = ts ? Date.parse(ts) : NaN;
  return {
    status: pick(/^Status:\s*(.+?)\.?\s*$/m),
    hashAlgorithm: pick(/^Hash Algorithm:\s*(\S+)/m),
    imprint: imprint || null,
    genTime: Number.isFinite(genMs) ? new Date(genMs).toISOString() : null,
    serial: pick(/^Serial number:\s*(\S+)/m),
  };
}

const ANCHOR_FILE = /^\d{4}-\d{2}-\d{2}-\d+\.json$/;

/**
 * RFC 3161 timestamps: the anchor record is hashed into a TimeStampReq (`openssl ts -query -sha256 -cert`), POSTed
 * to the TSA, and the signed TimeStampResp (.tsr) is kept next to the record. Verify re-checks the imprint, the
 * TSA's time against anchoredAt (no back-dating) and, with a CA file, the TSA signature (`openssl ts -verify`).
 */
export class Rfc3161AnchorProvider implements AnchorProvider {
  readonly name = 'rfc3161' as const;

  constructor(private readonly cfg: Rfc3161Config) {}

  private openssl(args: string[]) {
    return exec(this.cfg.opensslBin ?? 'openssl', args, { env: { ...process.env, LC_ALL: 'C' } });
  }

  private requireDir(): string {
    if (!this.cfg.dir)
      throw new AnchorError('no_data_dir', 'RFC 3161 anchors need an on-disk dataDir (or opts.tsrDir)');
    return this.cfg.dir;
  }

  async inspect(tsr: string): Promise<TsReplyInfo> {
    const r = await this.openssl(['ts', '-reply', '-in', tsr, '-text']);
    return r.code === 0
      ? parseTsReplyText(r.stdout.toString('utf8'))
      : { status: null, hashAlgorithm: null, imprint: null, genTime: null, serial: null };
  }

  private async verifyToken(tsr: string, input: string[]): Promise<{ ok: boolean; detail: string }> {
    const args = ['ts', '-verify', ...input, '-in', tsr, '-CAfile', this.cfg.caFile!];
    if (this.cfg.untrustedFile) args.push('-untrusted', this.cfg.untrustedFile);
    const r = await this.openssl(args);
    const out = r.stdout.toString('utf8');
    return { ok: r.code === 0 && /Verification: OK/.test(out), detail: brief(r.stderr || out) };
  }

  async create(record: AnchorRecord, file: string): Promise<CreatedAnchor> {
    const dir = this.requireDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const base = file.replace(/\.json$/, '');
    const json = join(dir, file);
    const tsq = join(dir, `${base}.tsq`);
    const tsr = join(dir, `${base}.tsr`);
    if (existsSync(json)) throw new AnchorError('anchor_file_conflict', `${file} already exists`);
    const raw = serializeAnchor(record);
    writeFileSync(json, raw, { mode: 0o600 });
    try {
      const q = await this.openssl(['ts', '-query', '-data', json, '-sha256', '-cert', '-out', tsq]);
      if (q.code !== 0) throw new AnchorError('tsq_failed', brief(q.stderr));
      const body = new Uint8Array(readFileSync(tsq));
      let res: Awaited<ReturnType<TsaFetch>>;
      try {
        res = await this.cfg.fetch(this.cfg.tsaUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/timestamp-query', accept: 'application/timestamp-reply' },
          body,
          signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000),
        });
      } catch (err) {
        throw new AnchorError('tsa_unreachable', String(err).slice(0, 300));
      }
      if (!res.ok) throw new AnchorError(`tsa_http_${res.status}`, `TSA answered HTTP ${res.status}`);
      const reply = Buffer.from(await res.arrayBuffer());
      if (!reply.length || reply.length > 1024 * 1024)
        throw new AnchorError('tsa_bad_reply', `reply of ${reply.length} bytes`);
      writeFileSync(tsr, reply, { mode: 0o600 });
      const info = await this.inspect(tsr);
      if (!info.status?.startsWith('Granted'))
        throw new AnchorError('tsa_rejected', `TSA status ${info.status ?? 'unreadable'}`);
      if (info.imprint !== sha256hex(raw))
        throw new AnchorError('tsr_imprint_mismatch', 'timestamp token does not cover the anchor record');
      if (this.cfg.caFile) {
        const v = await this.verifyToken(tsr, ['-queryfile', tsq]);
        if (!v.ok) throw new AnchorError('tsr_verify_failed', v.detail);
      }
      return { proofRef: `rfc3161:${base}` };
    } catch (err) {
      for (const f of [json, tsq, tsr]) rmSync(f, { force: true });
      throw err instanceof AnchorError ? err : new AnchorError('rfc3161_failed', String(err).slice(0, 300));
    }
  }

  async list(chainId: string): Promise<ExternalListing> {
    const dir = this.cfg.dir;
    if (!dir || !existsSync(dir)) return emptyListing();
    const listing = emptyListing();
    listing.available = true;
    for (const f of readdirSync(dir)
      .filter((n) => ANCHOR_FILE.test(n))
      .sort()) {
      const raw = readFileSync(join(dir, f), 'utf8');
      const record = parseAnchor(raw);
      if (!record) listing.problems.push(`rfc3161 ${f}: not a valid anchor record`);
      else if (record.chainId !== chainId) listing.foreign++;
      else listing.anchors.push({ provider: 'rfc3161', file: f, raw, record });
    }
    if (listing.anchors.length && !this.cfg.caFile)
      listing.warnings.push(
        'no TSA CA file configured: RFC 3161 token signatures are not verified (imprint and time only)',
      );
    return listing;
  }

  async locate(anchor: ExternalAnchor): Promise<string | null> {
    return `rfc3161:${anchor.file.replace(/\.json$/, '')}`;
  }

  async proof(anchor: ExternalAnchor, chain: ChainAnchor | null): Promise<ProofResult> {
    const problems: string[] = [];
    const base = anchor.file.replace(/\.json$/, '');
    if (chain && chain.proofRef !== `rfc3161:${base}`)
      problems.push(`anchor.created points at ${chain.proofRef}, not rfc3161:${base}`);
    const dir = this.cfg.dir;
    const tsr = dir ? join(dir, `${base}.tsr`) : null;
    if (!tsr || !existsSync(tsr)) {
      problems.push(`timestamp token ${base}.tsr is missing`);
      return { ok: false, problems, warnings: [], signed: null, offHost: null };
    }
    const info = await this.inspect(tsr);
    if (!info.status?.startsWith('Granted'))
      problems.push(`timestamp token ${base}.tsr status ${info.status ?? 'unreadable'}`);
    if (info.hashAlgorithm !== 'sha256')
      problems.push(`timestamp token ${base}.tsr uses ${info.hashAlgorithm ?? 'an unreadable'} digest`);
    if (info.imprint !== sha256hex(anchor.raw))
      problems.push(
        `timestamp token ${base}.tsr does not cover this anchor record (changed after timestamping?)`,
      );
    if (!info.genTime) problems.push(`timestamp token ${base}.tsr has no readable time`);
    else {
      const skew = Math.abs(Date.parse(info.genTime) - Date.parse(anchor.record.anchoredAt));
      if (!(skew <= this.cfg.maxSkewMs))
        problems.push(
          `TSA time ${info.genTime} is ${Math.round(skew / 60_000)} min away from anchoredAt ${anchor.record.anchoredAt} (back-dated record?)`,
        );
    }
    if (this.cfg.caFile) {
      const v = await this.verifyToken(tsr, ['-data', join(dir!, anchor.file)]);
      if (!v.ok) problems.push(`openssl ts -verify failed for ${base}.tsr: ${v.detail}`);
    }
    return { ok: problems.length === 0, problems, warnings: [], signed: null, offHost: null };
  }
}

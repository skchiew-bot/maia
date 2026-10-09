import { join, resolve } from 'node:path';
import {
  newId,
  type Actor,
  type AnchorCheckDTO,
  type AnchorDTO,
  type AnchorProviderName,
  type AuditHealthDTO,
  type AuditService as AuditServiceContract,
  type BackupDTO,
  type EventSource,
  type MetaOf,
  type StoredEvent,
  type VerifyReportDTO,
} from '@aoc/contracts';
import type { ModuleContext } from '@aoc/kernel';
import { BackupRunner, type BackupOutcome } from './backup/backup';
import {
  anchorFileName,
  linkageProblems,
  previousOf,
  type AnchorRecord,
  type ExternalAnchor,
} from './anchor-record';
import { GitAnchorProvider } from './anchor/git';
import {
  AnchorError,
  emptyListing,
  type AnchorProvider,
  type ChainAnchor,
  type CreatedAnchor,
  type ExternalListing,
} from './anchor/provider';
import { Rfc3161AnchorProvider } from './anchor/rfc3161';
import { detectConfigChanges, governedSources } from './config-watch';
import {
  DEFAULT_MIN_BACKUP_INTERVAL_MS,
  DEFAULT_STALE_AFTER_MS,
  DEFAULT_TSA_MAX_SKEW_MS,
  type AuditModuleOptions,
  type TsaFetch,
} from './options';

export type AnchorOutcome =
  | { ok: true; anchor: AnchorDTO; pushError: string | null; recovered: boolean }
  | { ok: false; skipped: 'disabled' | 'empty_chain' }
  | { ok: false; provider: AnchorProviderName; reason: string; detail: string };

export const AUDIT_SYSTEM_ACTOR: Actor = { kind: 'system', id: 'scheduler:audit' };
const PROVIDERS = ['git', 'rfc3161'] as const;
const LABEL = /^[a-z0-9_.:/-]{1,80}$/i;

const defaultFetch: TsaFetch = (url, init) => fetch(url, init);

/** Directory of RFC 3161 artefacts (null when the store is in-memory and no override is configured). */
export function tsrDirOf(dataDir: string, opts: AuditModuleOptions): string | null {
  if (opts.tsrDir) return resolve(opts.tsrDir);
  return dataDir === ':memory:' ? null : join(resolve(dataDir), 'anchors');
}

interface BackupRow {
  event_seq: number;
  backup_id: string;
  at: string;
  file: string;
  bytes: number;
  sha256: string;
  key_id: string;
  head_seq: number;
  head_hash: string;
  copied: number | null;
}

interface AnchorRow {
  anchor_id: string;
  provider: AnchorProviderName;
  seq: number;
  hash: string;
  proof_ref: string;
  signed: number | null;
  pushed: number | null;
  event_seq: number;
  anchored_at: string;
}

function anchorFromRow(r: AnchorRow): AnchorDTO {
  const bool = (v: number | null) => (v === null ? null : v === 1);
  return {
    anchorId: r.anchor_id,
    provider: r.provider,
    seq: r.seq,
    hash: r.hash,
    proofRef: r.proof_ref,
    anchoredAt: r.anchored_at,
    eventSeq: r.event_seq,
    signed: bool(r.signed),
    pushed: bool(r.pushed),
  };
}

function toAnchorDTO(e: StoredEvent): AnchorDTO {
  const m = e.meta as MetaOf<'anchor.created'>;
  return {
    anchorId: m.anchorId,
    provider: m.provider,
    seq: m.seq,
    hash: m.hash,
    proofRef: m.proofRef,
    anchoredAt: e.ts,
    eventSeq: e.seq,
    signed: m.signed ?? null,
    pushed: m.pushed ?? null,
  };
}

/**
 * Audit integrity (§13, R2): anchors the chain head off-host and verifies the whole chain against every anchor.
 * Anchor and verify runs are serialised; neither ever trusts the database alone — the off-host records are listed
 * independently, so deleted or rewritten anchor.created events are detected too. Provided to other modules as the
 * `audit` service.
 */
export class AuditService implements AuditServiceContract {
  readonly git: GitAnchorProvider;
  readonly rfc3161: Rfc3161AnchorProvider;
  readonly backups: BackupRunner;
  private queue: Promise<unknown> = Promise.resolve();
  /** Aborted on module stop: a running chain pass or backup ends at its next chunk instead of holding shutdown. */
  private readonly stopping = new AbortController();

  constructor(
    private readonly ctx: ModuleContext,
    private readonly opts: AuditModuleOptions = {},
  ) {
    const audit = ctx.config.audit;
    // aocd configures these through `audit.*`; module options override them (tests, embedding).
    this.git = new GitAnchorProvider({
      repoPath: resolve(audit.anchorRepoPath),
      remote: audit.anchorRemote,
      gpgKeyId: opts.gpgKeyId ?? audit.gpgKeyId,
      gnupgHome: opts.gnupgHome ?? audit.gnupgHome,
      gitBin: opts.gitBin,
    });
    this.rfc3161 = new Rfc3161AnchorProvider({
      dir: tsrDirOf(ctx.dataDir, opts),
      tsaUrl: audit.tsaUrl,
      fetch: opts.tsaFetch ?? defaultFetch,
      opensslBin: opts.opensslBin,
      caFile: opts.tsaCaFile ?? audit.tsaCaFile,
      untrustedFile: opts.tsaUntrustedFile ?? audit.tsaUntrustedFile,
      maxSkewMs: opts.tsaMaxSkewMs ?? DEFAULT_TSA_MAX_SKEW_MS,
    });
    this.backups = new BackupRunner(ctx);
  }

  /** Abort the running chain pass or backup and wait for queued work to settle (module stop). */
  async stop(): Promise<void> {
    this.stopping.abort();
    await this.queue;
  }

  get providerName(): AnchorProviderName | 'none' {
    return this.ctx.config.audit.anchorProvider;
  }

  /** git with a remote, or RFC 3161 (a third-party signature); a local-only git repo is not off-host. */
  get offHost(): boolean {
    return (
      this.providerName === 'rfc3161' || (this.providerName === 'git' && !!this.ctx.config.audit.anchorRemote)
    );
  }

  provider(name: AnchorProviderName): AnchorProvider {
    return name === 'git' ? this.git : this.rfc3161;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Anchors as recorded in the chain itself (not the projection). */
  chainAnchors(): ChainAnchor[] {
    return this.ctx.store.list({ types: ['anchor.created'], limit: 100_000 }).map((e) => {
      const d = toAnchorDTO(e);
      return { ...d, at: d.anchoredAt };
    });
  }

  anchorList(): AnchorDTO[] {
    const rows = this.ctx.db.prepare('SELECT * FROM aud_anchors ORDER BY seq, event_seq').all() as unknown as AnchorRow[];
    return rows.map(anchorFromRow);
  }

  /** The newest anchored position (highest seq) — the `audit` service's lastAnchor. */
  lastAnchor(): AnchorDTO | null {
    const row = this.ctx.db.prepare('SELECT * FROM aud_anchors ORDER BY seq DESC, event_seq DESC LIMIT 1').get() as
      | AnchorRow
      | undefined;
    return row ? anchorFromRow(row) : null;
  }

  // ── config ─────────────────────────────────────────────────────────────────
  detectConfig(source: EventSource): StoredEvent[] {
    return detectConfigChanges(
      this.ctx.store,
      this.ctx.db,
      governedSources(this.ctx.config, this.opts),
      { kind: 'system', id: 'audit' },
      source,
    );
  }

  // ── anchoring ──────────────────────────────────────────────────────────────
  private recordFailure(
    provider: AnchorProviderName,
    reason: string,
    detail: string,
    actor: Actor,
    source: EventSource,
  ): void {
    const label = LABEL.test(reason) ? reason : 'anchor_error';
    this.ctx.store.append({
      type: 'anchor.failed',
      actor,
      meta: { provider, reason: label },
      payload: { detail: detail.slice(0, 2000) },
      bodyScope: 'audit',
      source,
    });
    this.ctx.notify({
      kind: 'anchor.missed',
      title:
        label === 'push_failed' ? 'Audit anchor was not pushed off-host' : 'Off-host audit anchor failed',
      audience: ['approver', 'builder'],
      severity: 'danger',
      link: '/audit',
      refs: { provider, reason: label },
    });
  }

  private appendCreated(
    provider: AnchorProviderName,
    record: AnchorRecord,
    created: CreatedAnchor,
    actor: Actor,
    source: EventSource,
  ): StoredEvent {
    return this.ctx.store.append({
      type: 'anchor.created',
      actor,
      meta: {
        anchorId: newId('anchor', this.ctx.clock.now()),
        seq: record.seq,
        hash: record.hash,
        provider,
        proofRef: created.proofRef,
        ...(created.signed !== undefined ? { signed: created.signed } : {}),
        ...(created.pushed !== undefined ? { pushed: created.pushed } : {}),
      },
      idempotencyKey: `anchor:${provider}:${record.chainId}:${record.seq}`,
      source,
    });
  }

  /**
   * Anchor the current head with the configured provider. Refuses to anchor a chain that does not verify against
   * the anchors already made (never launder a rewritten history), and re-records off-host anchors whose
   * anchor.created append was lost.
   */
  anchorNow(actor: Actor, source: EventSource, recordFailure = true): Promise<AnchorOutcome> {
    return this.exclusive(async () => {
      const name = this.providerName;
      if (name === 'none') return { ok: false, skipped: 'disabled' };
      const provider = this.provider(name);
      const { store } = this.ctx;
      const fail = (reason: string, detail: string): AnchorOutcome => {
        if (recordFailure) this.recordFailure(name, reason, detail, actor, source);
        return { ok: false, provider: name, reason, detail };
      };
      if (store.head().seq === 0) return { ok: false, skipped: 'empty_chain' };
      let listing: ExternalListing;
      try {
        listing = await provider.list(store.chainId);
      } catch (err) {
        return fail('anchor_store_unreadable', String(err));
      }
      if (listing.problems.length)
        return fail('anchor_store_invalid', listing.problems.slice(0, 3).join('; '));
      const known = this.chainAnchors().filter((a) => a.provider === name);
      // Captured in the same tick as the verifier's upper bound (the stored head), so rows added behind the store's
      // back show up as a head mismatch while events appended during the chunked pass do not.
      const head = store.head();
      const v = await store.verifyChainAsync({
        atSeqs: [...known.map((a) => a.seq), ...listing.anchors.map((a) => a.record.seq)],
        signal: this.stopping.signal,
      });
      if (v.headSeq !== head.seq || v.headHash !== head.hash)
        return fail(
          'head_mismatch',
          `in-memory head ${head.seq} differs from the stored chain head ${v.headSeq}`,
        );
      if (!v.ok) return fail('chain_invalid', v.problems.slice(0, 5).join('; '));
      for (const a of known)
        if (v.hashesAt[a.seq] !== a.hash)
          return fail('anchor_mismatch', `chain hash at seq ${a.seq} no longer matches anchor ${a.anchorId}`);
      for (const a of listing.anchors)
        if (v.hashesAt[a.record.seq] !== a.record.hash)
          return fail(
            'anchor_mismatch',
            `chain hash at seq ${a.record.seq} differs from off-host anchor ${a.file}`,
          );

      const knownSeqs = new Set(known.map((a) => a.seq));
      let recovered: StoredEvent | null = null;
      for (const a of listing.anchors.filter((x) => !knownSeqs.has(x.record.seq))) {
        const proofRef = await provider.locate(a, listing);
        if (!proofRef) continue;
        const e = this.appendCreated(name, a.record, { proofRef }, actor, source);
        this.ctx.log.warn('audit: re-recorded an off-host anchor that had no anchor.created event', {
          provider: name,
          seq: a.record.seq,
        });
        if (a.record.seq === head.seq) recovered = e;
      }
      if (recovered) return { ok: true, anchor: toAnchorDTO(recovered), pushError: null, recovered: true };

      const record: AnchorRecord = {
        chainId: store.chainId,
        seq: head.seq,
        hash: head.hash,
        anchoredAt: this.ctx.clock.iso(),
        previousAnchor: previousOf(listing.anchors),
      };
      let created: CreatedAnchor;
      try {
        created = await provider.create(record, anchorFileName(record, this.ctx.config.timezone));
      } catch (err) {
        const e = err instanceof AnchorError ? err : new AnchorError('anchor_error', String(err));
        return fail(e.reason, e.detail);
      }
      const e = this.appendCreated(name, record, created, actor, source);
      // The anchor exists locally but is not off-host until the next successful push: alert, but keep it.
      if (created.pushed === false)
        this.recordFailure(name, 'push_failed', created.pushError ?? '', actor, source);
      return { ok: true, anchor: toAnchorDTO(e), pushError: created.pushError ?? null, recovered: false };
    });
  }

  // ── verification ───────────────────────────────────────────────────────────
  /** The `audit` service's verify: recorded as chain.verified only when asked to. */
  verify(record?: { actor: Actor; source: EventSource }): Promise<VerifyReportDTO> {
    return record ? this.verifyNow(record.actor, record.source) : this.exclusive(() => this.computeVerify());
  }

  /** Verify-against-anchor; appends chain.verified (and alerts when it fails). */
  verifyNow(actor: Actor, source: EventSource): Promise<VerifyReportDTO> {
    return this.exclusive(async () => {
      const report = await this.computeVerify();
      const e = this.ctx.store.append({
        type: 'chain.verified',
        actor,
        meta: {
          ok: report.ok,
          headSeq: report.headSeq,
          checked: report.checked,
          anchorsChecked: report.anchors.length,
          anchorsMatched: report.anchors.filter((a) => a.matched && a.proofOk).length,
          firstBadSeq: report.firstBadSeq,
          unanchoredTail: report.unanchoredTail,
        },
        payload: { problems: report.problems.slice(0, 200) },
        bodyScope: 'audit',
        source,
      });
      report.eventSeq = e.seq;
      if (!report.ok) {
        this.ctx.notify({
          kind: 'audit.integrity',
          title: 'Audit chain verification FAILED',
          audience: ['approver', 'builder'],
          severity: 'danger',
          link: '/audit',
          refs: { firstBadSeq: String(report.firstBadSeq ?? ''), eventSeq: String(e.seq) },
        });
      }
      return report;
    });
  }

  async computeVerify(): Promise<VerifyReportDTO> {
    const { store, clock } = this.ctx;
    const problems: string[] = [];
    const warnings: string[] = [];
    const chainAnchors = this.chainAnchors();
    const listings: Record<AnchorProviderName, ExternalListing> = {
      git: emptyListing(),
      rfc3161: emptyListing(),
    };
    for (const name of PROVIDERS) {
      try {
        listings[name] = await this.provider(name).list(store.chainId);
      } catch (err) {
        problems.push(`${name} anchor store unreadable: ${String(err).slice(0, 200)}`);
      }
      const l = listings[name];
      problems.push(...l.problems, ...linkageProblems(l.anchors));
      warnings.push(...l.warnings);
      if (l.foreign)
        problems.push(
          `${name} anchor store holds ${l.foreign} anchor(s) of a different chain id — the event log may have been replaced`,
        );
    }
    const seqs = new Set<number>(chainAnchors.map((a) => a.seq));
    for (const name of PROVIDERS) for (const a of listings[name].anchors) seqs.add(a.record.seq);
    const v = await store.verifyChainAsync({ atSeqs: [...seqs], signal: this.stopping.signal });
    problems.push(...v.problems.map((p) => `in-file chain: ${p}`));

    const checks: AnchorCheckDTO[] = [];
    for (const name of PROVIDERS) {
      const listing = listings[name];
      const ext = new Map<number, ExternalAnchor>();
      for (const a of listing.anchors) if (!ext.has(a.record.seq) || a.remoteOnly) ext.set(a.record.seq, a);
      const inChain = new Map<number, ChainAnchor>();
      for (const a of chainAnchors) if (a.provider === name && !inChain.has(a.seq)) inChain.set(a.seq, a);
      for (const seq of [...new Set([...ext.keys(), ...inChain.keys()])].sort((a, b) => a - b)) {
        const x = ext.get(seq) ?? null;
        const d = inChain.get(seq) ?? null;
        const anchoredHash = x?.record.hash ?? d!.hash;
        const recomputed = v.hashesAt[seq] ?? null;
        const check: AnchorCheckDTO = {
          anchorId: d?.anchorId ?? null,
          provider: name,
          seq,
          anchoredHash,
          recomputedHash: recomputed,
          matched: recomputed !== null && recomputed === anchoredHash,
          proofOk: false,
          anchoredAt: x?.record.anchoredAt ?? d?.at ?? null,
          proofRef: d?.proofRef ?? null,
          signed: null,
          offHost: null,
          problems: [],
        };
        if (recomputed === null)
          check.problems.push(`seq ${seq} is beyond the chain head ${v.headSeq} (events deleted?)`);
        else if (!check.matched)
          check.problems.push(`recomputed chain hash at seq ${seq} differs from the off-host anchor`);
        if (!x) {
          check.problems.push(
            listing.available
              ? 'the off-host record of this anchor is missing'
              : `the ${name} anchor store is unavailable`,
          );
        } else {
          const proof = await this.provider(name).proof(x, d, listing);
          check.signed = proof.signed;
          check.offHost = proof.offHost;
          check.problems.push(...proof.problems);
          warnings.push(...proof.warnings.map((w) => `${name} anchor seq ${seq}: ${w}`));
          if (!d) check.problems.push('no anchor.created event in the chain records this off-host anchor');
          else if (d.hash !== x.record.hash)
            check.problems.push(
              'the anchor.created event in the chain records a different hash than the off-host record',
            );
          const lostOffHost = d?.pushed === true && proof.offHost === false;
          if (lostOffHost)
            check.problems.push(
              'this anchor was pushed off-host but is no longer on the remote (remote history rewritten?)',
            );
          check.proofOk = proof.ok && d !== null && d.hash === x.record.hash && !lostOffHost;
        }
        for (const p of check.problems) problems.push(`${name} anchor seq ${seq}: ${p}`);
        checks.push(check);
      }
    }

    // A perfect in-file forgery recomputes cleanly; the first anchor it breaks bounds where the rewrite happened.
    let firstBadSeq = v.firstBadSeq;
    let lastGood = 0;
    for (const c of [...checks].sort((a, b) => a.seq - b.seq)) {
      if (c.matched) {
        lastGood = Math.max(lastGood, c.seq);
        continue;
      }
      const from = lastGood + 1;
      firstBadSeq = firstBadSeq === null ? from : Math.min(firstBadSeq, from);
      problems.push(`events ${from}..${c.seq} do not match the ${c.provider} anchor at seq ${c.seq}`);
      break;
    }
    const last = checks.reduce<AnchorCheckDTO | null>((m, c) => (m === null || c.seq > m.seq ? c : m), null);
    if (!checks.length && v.headSeq > 0)
      warnings.push('no anchors yet: nothing protects the chain against a recompute (R2)');
    if (this.providerName === 'none') warnings.push('anchoring is disabled (audit.anchorProvider = none)');
    else if (!this.offHost)
      warnings.push('git anchors are not pushed off-host (audit.anchorRemote is not set)');
    return {
      ok: problems.length === 0,
      chainOk: v.ok,
      chainId: store.chainId,
      headSeq: v.headSeq,
      headHash: v.headHash,
      checked: v.checked,
      anchors: checks,
      firstBadSeq,
      unanchoredTail: Math.max(0, v.headSeq - (last?.seq ?? 0)),
      lastAnchorSeq: last?.seq ?? null,
      lastAnchorAt: last?.anchoredAt ?? null,
      remoteChecked: listings.git.remoteChecked,
      problems: [...new Set(problems)],
      warnings: [...new Set(warnings)],
      verifiedAt: clock.iso(),
      eventSeq: null,
    };
  }

  /** Nightly: governed-config check, anchor (with retries; only the final failure is recorded), then verify. */
  async nightly(): Promise<void> {
    this.detectConfig('scheduler');
    const retries = this.opts.anchorRetries ?? 2;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const final = attempt === retries;
      const r = await this.anchorNow(AUDIT_SYSTEM_ACTOR, 'scheduler', final);
      if (r.ok || 'skipped' in r) break;
      if (!final) await new Promise((res) => setTimeout(res, this.opts.retryDelayMs ?? 30_000));
    }
    await this.verifyNow(AUDIT_SYSTEM_ACTOR, 'scheduler');
  }

  // ── backups (G-21) ─────────────────────────────────────────────────────────
  /**
   * Run a backup now, serialised with anchoring and verify, so no snapshot holds an anchor committed off-host but not
   * yet recorded. A manual run is refused while the last backup is younger than minBackupIntervalMs.
   */
  backupNow(actor: Actor, source: EventSource, opts: { manual?: boolean } = {}): Promise<BackupOutcome> {
    return this.exclusive(async () => {
      if (opts.manual) {
        const last = this.lastBackup();
        const min = this.opts.minBackupIntervalMs ?? DEFAULT_MIN_BACKUP_INTERVAL_MS;
        if (last && this.ctx.clock.now() - Date.parse(last.at) < min) return { ok: false, skipped: 'too_recent' };
      }
      return this.backups.run(actor, source, this.stopping.signal);
    });
  }

  /** Completed backups, newest first. */
  backupList(limit = 100): BackupDTO[] {
    const rows = this.ctx.db
      .prepare('SELECT * FROM aud_backups ORDER BY event_seq DESC LIMIT ?')
      .all(limit) as unknown as BackupRow[];
    return rows.map((r) => ({
      backupId: r.backup_id,
      at: r.at,
      file: r.file,
      bytes: r.bytes,
      sha256: r.sha256,
      keyId: r.key_id,
      headSeq: r.head_seq,
      headHash: r.head_hash,
      copied: r.copied === null ? null : r.copied === 1,
      eventSeq: r.event_seq,
    }));
  }

  lastBackup(): BackupDTO | null {
    return this.backupList(1)[0] ?? null;
  }

  // ── health ─────────────────────────────────────────────────────────────────
  health(): AuditHealthDTO {
    const { store, db, clock } = this.ctx;
    const now = clock.now();
    const staleAfterMs = this.opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    const head = store.head();
    const last = db
      .prepare(
        'SELECT anchor_id, provider, seq, anchored_at FROM aud_anchors ORDER BY seq DESC, event_seq DESC LIMIT 1',
      )
      .get() as
      { anchor_id: string; provider: AnchorProviderName; seq: number; anchored_at: string } | undefined;
    const failure = db
      .prepare(
        'SELECT provider, reason, at, event_seq FROM aud_anchor_failures ORDER BY event_seq DESC LIMIT 1',
      )
      .get() as { provider: AnchorProviderName; reason: string; at: string; event_seq: number } | undefined;
    const lastAnchorEvent =
      (db.prepare('SELECT MAX(event_seq) AS s FROM aud_anchors').get() as { s: number | null }).s ?? 0;
    const verification = db
      .prepare(
        'SELECT event_seq, at, ok, first_bad_seq FROM aud_verifications ORDER BY event_seq DESC LIMIT 1',
      )
      .get() as { event_seq: number; at: string; ok: number; first_bad_seq: number | null } | undefined;
    let reactorFailures: AuditHealthDTO['reactorFailures'] = { total: 0, recent: [] };
    let jobs: AuditHealthDTO['jobs'] = [];
    try {
      reactorFailures = {
        total: (db.prepare('SELECT COUNT(*) AS n FROM reactor_failures').get() as { n: number }).n,
        recent: (
          db
            .prepare('SELECT reactor, seq, error, at FROM reactor_failures ORDER BY id DESC LIMIT 20')
            .all() as { reactor: string; seq: number; error: string; at: string }[]
        ).map((r) => ({ ...r, error: r.error.slice(0, 300) })),
      };
      jobs = (
        db
          .prepare(
            'SELECT name, last_run_at, last_local_date, last_status, last_error FROM job_runs ORDER BY name',
          )
          .all() as {
          name: string;
          last_run_at: string | null;
          last_local_date: string | null;
          last_status: string | null;
          last_error: string | null;
        }[]
      ).map((r) => ({
        name: r.name,
        lastRunAt: r.last_run_at,
        lastLocalDate: r.last_local_date,
        lastStatus: r.last_status,
        lastError: r.last_error?.slice(0, 300) ?? null,
      }));
    } catch {
      // runtime bookkeeping tables are absent outside AocRuntime
    }
    const since = new Date(now - 24 * 3600_000).toISOString();
    const selfmod = db
      .prepare('SELECT COUNT(*) AS total, COALESCE(SUM(at >= ?), 0) AS recent FROM aud_selfmod')
      .get(since) as { total: number; recent: number };
    const projections = store.projectionHealth();
    const lastAnchor = last
      ? {
          anchorId: last.anchor_id,
          provider: last.provider,
          seq: last.seq,
          at: last.anchored_at,
          ageMs: Math.max(0, now - Date.parse(last.anchored_at)),
        }
      : null;
    const anchorStale =
      this.providerName !== 'none' && head.seq > 0 && (!lastAnchor || lastAnchor.ageMs > staleAfterMs);
    const backupConfigured = this.backups.configured;
    const backup = this.lastBackup();
    const lastBackup = backup ? { ...backup, ageMs: Math.max(0, now - Date.parse(backup.at)) } : null;
    const backupFailure = db
      .prepare('SELECT event_seq, at, stage, reason FROM aud_backup_failures ORDER BY event_seq DESC LIMIT 1')
      .get() as { event_seq: number; at: string; stage: string; reason: string } | undefined;
    const backupStale = backupConfigured && head.seq > 0 && (!lastBackup || lastBackup.ageMs > staleAfterMs);

    const warnings: string[] = [];
    if (this.providerName === 'none') warnings.push('anchoring_disabled');
    else if (!this.offHost) warnings.push('anchor_not_off_host');
    if (this.providerName !== 'none' && head.seq > 0 && !lastAnchor) warnings.push('anchor_never');
    else if (anchorStale) warnings.push('anchor_stale');
    if (failure && failure.event_seq > lastAnchorEvent) warnings.push('anchor_failed');
    if (verification && !verification.ok) warnings.push('verify_failed');
    if (projections.some((p) => p.status !== 'ok')) warnings.push('projection_degraded');
    if (reactorFailures.total > 0) warnings.push('reactor_failures');
    if (jobs.some((j) => j.lastStatus === 'error')) warnings.push('job_failed');
    if (!backupConfigured) warnings.push('backup_not_configured');
    else if (head.seq > 0 && !lastBackup) warnings.push('backup_never');
    else if (backupStale) warnings.push('backup_stale');
    if (backupFailure && backupFailure.event_seq > (lastBackup?.eventSeq ?? 0)) warnings.push('backup_failed');
    if (lastBackup?.copied === false) warnings.push('backup_not_copied');
    return {
      generatedAt: clock.iso(),
      chainId: store.chainId,
      headSeq: head.seq,
      provider: this.providerName,
      offHost: this.offHost,
      lastAnchor,
      anchorStale,
      staleAfterMs,
      unanchoredTail: Math.max(0, head.seq - (lastAnchor?.seq ?? 0)),
      lastAnchorFailure: failure
        ? { at: failure.at, provider: failure.provider, reason: failure.reason }
        : null,
      lastVerification: verification
        ? {
            at: verification.at,
            ok: verification.ok === 1,
            firstBadSeq: verification.first_bad_seq,
            eventSeq: verification.event_seq,
          }
        : null,
      projections,
      reactorFailures,
      jobs,
      selfmodBlocked: { total: selfmod.total, last24h: selfmod.recent },
      backup: {
        configured: backupConfigured,
        last: lastBackup,
        lastFailure: backupFailure
          ? { at: backupFailure.at, stage: backupFailure.stage, reason: backupFailure.reason }
          : null,
        stale: backupStale,
      },
      warnings,
    };
  }
}

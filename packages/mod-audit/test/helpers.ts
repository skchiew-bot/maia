import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { JsonObject, Notification } from '@aoc/contracts';
import { canonicalJson, createTestRuntime, sha256hex, type TestRuntime, type TestUser } from '@aoc/kernel';
import { createAuditModule, type AuditModuleOptions, type TsaFetch } from '../src';

export interface AuditTest {
  t: TestRuntime;
  mod: ReturnType<typeof createAuditModule>;
  approver: TestUser;
  builder: TestUser;
  requester: TestUser;
  notes: Notification[];
}

export async function auditRuntime(
  o: {
    opts?: AuditModuleOptions;
    config?: Record<string, unknown>;
    onDisk?: boolean;
    now?: string | number;
  } = {},
): Promise<AuditTest> {
  const mod = createAuditModule({ retryDelayMs: 0, ...o.opts });
  const t = await createTestRuntime({
    modules: [mod],
    onDisk: o.onDisk ?? true,
    // Anchoring stays manual unless a test turns the interval job or the event trigger on (G-40).
    config: {
      ...o.config,
      audit: { anchorIntervalMinutes: 0, anchorAfterEvents: false, ...(o.config?.audit as object) },
    } as never,
    now: o.now,
  });
  const notes: Notification[] = [];
  t.rt.broadcaster.subscribe({
    role: 'approver',
    send: (m) => void (m.event === 'notification' && notes.push(m.data)),
  });
  return {
    t,
    mod,
    approver: t.user('approver'),
    builder: t.user('builder'),
    requester: t.user('requester'),
    notes,
  };
}

export function nudge(t: TestRuntime, sessionId: string, text: string) {
  return t.rt.store.append({
    type: 'session.nudged',
    actor: { kind: 'human', id: 'usr_test' },
    scope: { sessionId },
    meta: { sessionId },
    payload: { text },
    source: 'api',
  });
}

/**
 * The R2 attack: open aoc.db directly, drop the append-only triggers, rewrite one event and recompute every later
 * hash so the in-file chain verifies perfectly. With `rewriteAnchorMeta` the anchor.created events are rewritten to
 * the forged hashes too (the database then agrees with itself everywhere).
 */
export function forgeChain(
  dataDir: string,
  o: { seq: number; mutate: (meta: JsonObject) => JsonObject; rewriteAnchorMeta?: boolean },
): void {
  const db = new DatabaseSync(join(dataDir, 'aoc.db'));
  try {
    db.exec('DROP TRIGGER IF EXISTS events_append_only_u; DROP TRIGGER IF EXISTS events_append_only_d;');
    const chainId = (db.prepare("SELECT v FROM chain_info WHERE k = 'chain_id'").get() as { v: string }).v;
    const rows = db.prepare('SELECT * FROM events ORDER BY seq').all() as Record<
      string,
      string | number | null
    >[];
    const forged = new Map<number, string>();
    let prev = sha256hex(`aoc-genesis:${chainId}`);
    for (const r of rows) {
      const seq = r.seq as number;
      let meta = JSON.parse(r.meta as string) as JsonObject;
      if (seq === o.seq) meta = o.mutate(meta);
      if (o.rewriteAnchorMeta && r.type === 'anchor.created')
        meta = { ...meta, hash: forged.get(meta.seq as number) ?? (meta.hash as string) };
      const header = {
        v: 1,
        chainId,
        seq,
        id: r.id,
        ts: r.ts,
        type: r.type,
        actor: { kind: r.actor_kind, id: r.actor_id },
        scope: JSON.parse(r.scope_json as string) as JsonObject,
        meta,
        payloadHash: r.payload_hash,
        bodyScope: r.body_scope,
        source: r.source,
        sourceTs: r.source_ts,
        idempotencyKey: r.idempotency_key,
        causationId: r.causation_id,
        prevHash: prev,
      };
      const hash = sha256hex(canonicalJson(header));
      forged.set(seq, hash);
      db.prepare('UPDATE events SET meta = ?, prev_hash = ?, hash = ? WHERE seq = ?').run(
        canonicalJson(meta),
        prev,
        hash,
        seq,
      );
      prev = hash;
    }
  } finally {
    db.close();
  }
}

export function git(dir: string, args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(
    'git',
    ['-c', 'commit.gpgsign=false', '-c', 'user.name=Mallory', '-c', 'user.email=m@localhost', ...args],
    {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    },
  );
  return { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: r.stderr ?? '' };
}

/** Throwaway OpenPGP signing key in a temp GNUPGHOME; null when gpg cannot generate keys here. */
export function makeGpgKey(): { home: string; fpr: string; cleanup(): void } | null {
  const home = mkdtempSync(join(tmpdir(), 'aoc-gpg-'));
  const cleanup = () => {
    spawnSync('gpgconf', ['--homedir', home, '--kill', 'gpg-agent']);
    rmSync(home, { recursive: true, force: true });
  };
  try {
    chmodSync(home, 0o700);
    const gen = spawnSync(
      'gpg',
      [
        '--batch',
        '--homedir',
        home,
        '--pinentry-mode',
        'loopback',
        '--passphrase',
        '',
        '--quick-gen-key',
        'AOC Anchor Test <aoc-anchor-test@localhost>',
        'ed25519',
        'sign',
        'never',
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    if (gen.status !== 0) throw new Error(gen.stderr);
    const list = spawnSync('gpg', ['--homedir', home, '--list-secret-keys', '--with-colons'], {
      encoding: 'utf8',
    });
    const fpr = /^fpr:+([0-9A-F]{40}):/m.exec(list.stdout ?? '')?.[1];
    if (!fpr) throw new Error('no fingerprint');
    return { home, fpr, cleanup };
  } catch {
    cleanup();
    return null;
  }
}

export function openssl(args: string[], cwd: string): string {
  const r = spawnSync('openssl', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`openssl ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/**
 * A real RFC 3161 TSA built from openssl (`openssl ts -reply`) behind an injected fetch: the test exercises the
 * genuine TimeStampReq / TimeStampResp formats without network.
 */
export function makeLocalTsa(): {
  caFile: string;
  fetch: TsaFetch;
  calls: { url: string; headers: Record<string, string>; body: Buffer }[];
  fail: { status: number | null };
  cleanup(): void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'aoc-tsa-'));
  openssl(
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'ca.key',
      '-out',
      'ca.crt',
      '-subj',
      '/CN=AOC Test TSA CA',
      '-days',
      '2',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    ],
    dir,
  );
  openssl(
    [
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'tsa.key',
      '-out',
      'tsa.csr',
      '-subj',
      '/CN=AOC Test TSA',
    ],
    dir,
  );
  writeFileSync(
    join(dir, 'ext.cnf'),
    'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,timeStamping\n',
  );
  openssl(
    [
      'x509',
      '-req',
      '-in',
      'tsa.csr',
      '-CA',
      'ca.crt',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      'tsa.crt',
      '-days',
      '2',
      '-extfile',
      'ext.cnf',
    ],
    dir,
  );
  writeFileSync(join(dir, 'tsaserial'), '01\n');
  writeFileSync(
    join(dir, 'tsa.cnf'),
    [
      '[ tsa ]',
      'default_tsa = tsa_config1',
      '[ tsa_config1 ]',
      `dir = ${dir}`,
      'serial = $dir/tsaserial',
      'crypto_device = builtin',
      'signer_cert = $dir/tsa.crt',
      'certs = $dir/tsa.crt',
      'signer_key = $dir/tsa.key',
      'signer_digest = sha256',
      'default_policy = 1.2.3.4.1',
      'other_policies = 1.2.3.4.5',
      'digests = sha256, sha384, sha512',
      'accuracy = secs:1',
      'ordering = no',
      'tsa_name = yes',
      'ess_cert_id_chain = no',
      'ess_cert_id_alg = sha256',
      '',
    ].join('\n'),
  );
  const calls: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
  const fail = { status: null as number | null };
  let n = 0;
  const fetch: TsaFetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: Buffer.from(init.body) });
    if (fail.status !== null)
      return { ok: false, status: fail.status, arrayBuffer: async () => new ArrayBuffer(0) };
    const q = join(dir, `q${++n}.tsq`);
    const r = join(dir, `r${n}.tsr`);
    writeFileSync(q, init.body);
    openssl(['ts', '-reply', '-config', join(dir, 'tsa.cnf'), '-queryfile', q, '-out', r], dir);
    const bytes = new Uint8Array(readFileSync(r));
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer };
  };
  return {
    caFile: join(dir, 'ca.crt'),
    fetch,
    calls,
    fail,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

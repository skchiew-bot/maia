import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { AocConfigSchema, type AocConfig, type Notification, type Role, type StoredEvent } from '@aoc/contracts';
import { AocRuntime, DevIdentityService, FakeClock, silentLogger, type AocModule, type AppEnv } from '@aoc/kernel';
import { createAuditModule, type AuditModuleOptions } from '../src';
import { git } from './helpers';

export const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

/**
 * One AOC host plus what lives elsewhere: the KEK in escrow, the backup key in its own custody directory, and a bare
 * git repository standing in for the off-host anchor remote.
 */
export interface Site {
  root: string;
  dataDir: string;
  backupDir: string;
  custody: string;
  kek: Buffer;
  backupKey: Buffer;
  backupKeyFile: string;
  remote: string;
  config: AocConfig;
  cleanup(): void;
}

export function makeSite(audit: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Site {
  const root = mkdtempSync(join(tmpdir(), 'aoc-backup-site-'));
  const custody = join(root, 'custody');
  mkdirSync(custody, { mode: 0o700 });
  const backupKey = randomBytes(32);
  const backupKeyFile = join(custody, 'backup.key');
  writeFileSync(backupKeyFile, `${backupKey.toString('hex')}\n`, { mode: 0o400 });
  const remote = join(root, 'anchor-remote.git');
  mkdirSync(remote);
  git(remote, ['init', '-q', '--bare', '-b', 'main']);
  const dataDir = join(root, 'data');
  const backupDir = join(root, 'backups');
  const config = AocConfigSchema.parse({
    dataDir,
    supervisor: { workspacesDir: join(root, 'workspaces') },
    selfModification: { externalAuditLog: join(root, 'selfmod.log') },
    ...extra,
    audit: {
      anchorRepoPath: join(root, 'anchor-repo'),
      anchorRemote: remote,
      backupDir,
      backupKeyFile,
      anchorIntervalMinutes: 0,
      anchorAfterEvents: false,
      ...audit,
    },
  });
  return {
    root,
    dataDir,
    backupDir,
    custody,
    kek: randomBytes(32),
    backupKey,
    backupKeyFile,
    remote,
    config,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export interface Booted {
  rt: AocRuntime;
  app: Hono<AppEnv>;
  clock: FakeClock;
  mod: ReturnType<typeof createAuditModule>;
  notes: Notification[];
  user(role: Role): { id: string; headers: Record<string, string> };
  request(method: string, path: string, headers?: Record<string, string>): Promise<Response>;
  json<T>(method: string, path: string, headers: Record<string, string>, expect?: number): Promise<T>;
  close(): Promise<void>;
}

/** aocd's runtime on the site's data dir with the given KEK (the escrowed one unless overridden). */
export async function boot(
  site: Site,
  o: { now?: string; opts?: AuditModuleOptions; kek?: Buffer; config?: AocConfig } = {},
): Promise<Booted> {
  const clock = new FakeClock(o.now ?? '2026-10-09T02:00:00.000Z');
  const mod = createAuditModule({ retryDelayMs: 0, ...o.opts });
  let identity: DevIdentityService | null = null;
  const identityModule: AocModule = {
    name: 'test-identity',
    init(ctx) {
      identity = new DevIdentityService(ctx.store);
      ctx.services.provide('identity', identity);
    },
  };
  const config = o.config ?? site.config;
  const rt = await AocRuntime.create({
    config,
    modules: [identityModule, mod],
    clock,
    log: silentLogger,
    masterKey: o.kek ?? site.kek,
    dataDir: config.dataDir,
  });
  const app = rt.mount(new Hono<AppEnv>());
  const notes: Notification[] = [];
  rt.broadcaster.subscribe({
    role: 'approver',
    send: (m) => void (m.event === 'notification' && notes.push(m.data)),
  });
  const request = (method: string, path: string, headers: Record<string, string> = {}) =>
    Promise.resolve(app.request(path, { method, headers }));
  return {
    rt,
    app,
    clock,
    mod,
    notes,
    user(role) {
      const { user, token } = (identity as unknown as DevIdentityService).createUser({ role });
      return { id: user.id, headers: { authorization: `Bearer ${token}` } };
    },
    request,
    async json<T>(method: string, path: string, headers: Record<string, string>, expect = 200): Promise<T> {
      const res = await request(method, path, headers);
      const text = await res.text();
      if (res.status !== expect) throw new Error(`${method} ${path} → ${res.status} (expected ${expect}): ${text}`);
      return JSON.parse(text) as T;
    },
    close: () => rt.stop(),
  };
}

export function nudge(b: Booted, sessionId: string, text: string): StoredEvent {
  return b.rt.store.append({
    type: 'session.nudged',
    actor: { kind: 'human', id: 'usr_test' },
    scope: { sessionId },
    meta: { sessionId },
    payload: { text },
    source: 'api',
  });
}

export const SYSTEM = { kind: 'system' as const, id: 'test' };

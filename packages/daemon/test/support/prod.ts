/**
 * The production composition (every module of createDefaultModules, real mod-identity, the real supervisor module)
 * booted in-process on a fake clock, for the cross-module property tests. No claude process is ever started: the
 * supervisor module only recovers sessions found in the log, and these histories hold none that are running.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AocConfigSchema, type AocConfig, type Role } from '@aoc/contracts';
import { createLogger, FakeClock, silentLogger, type AocModule, type EventStore, type Logger } from '@aoc/kernel';
import {
  createIdentityModule,
  identityServiceOf,
  identityTestHelpers,
  type IdentityTestHelpers,
  type IdentityTestUser,
} from '@aoc/mod-identity';
import { repoRoot } from '../helpers';
import { createDefaultModules } from '../../src/modules';
import { createAocServer, type AocServer } from '../../src/server';

export interface ProdOptions {
  config?: Record<string, unknown>;
  now?: string;
  /** Existing data dir (restart / reopen a seeded history). Default: a fresh temp dir. */
  dataDir?: string;
  masterKey?: Buffer;
  /** Swap or drop modules of the production list (by name). */
  modules?: (list: AocModule[]) => AocModule[];
  /** Collect error-level log lines (name, error text) instead of dropping them. */
  captureErrors?: boolean;
}

export interface Prod {
  aoc: AocServer;
  store: EventStore;
  clock: FakeClock;
  dir: string;
  masterKey: Buffer;
  ids: IdentityTestHelpers;
  config: AocConfig;
  /** Error-level log lines (only with captureErrors). */
  errors: string[];
  user(role: Role, name?: string, opts?: { complianceLead?: boolean }): IdentityTestUser;
  request(method: string, path: string, init?: { headers?: Record<string, string>; body?: unknown }): Promise<Response>;
  close(): Promise<void>;
}

export function prodConfig(dir: string, overrides: Record<string, unknown> = {}): AocConfig {
  return AocConfigSchema.parse({
    dataDir: join(dir, 'data'),
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'http://aoc.test',
    identity: { origin: 'http://aoc.test', rpId: 'aoc.test' },
    registryFile: join(repoRoot, 'config', 'process-types.json'),
    supervisor: { workspacesDir: join(dir, 'workspaces') },
    metering: { rateCardFile: join(repoRoot, 'config', 'rate-card.json') },
    compliance: { mappingFile: join(repoRoot, 'config', 'iso42001-mapping.json') },
    fx: { extractor: 'fake' },
    audit: { anchorRepoPath: join(dir, 'anchor-repo') },
    selfModification: { externalAuditLog: join(dir, 'selfmod-audit.log') },
    ...overrides,
  });
}

export async function bootProd(opts: ProdOptions = {}): Promise<Prod> {
  const ownDir = opts.dataDir === undefined;
  const dir = ownDir ? mkdtempSync(join(tmpdir(), 'aoc-prop-')) : opts.dataDir!;
  const config = prodConfig(dir, opts.config);
  const clock = new FakeClock(opts.now ?? '2026-10-09T02:00:00.000Z');
  const masterKey = opts.masterKey ?? randomBytes(32);
  const list = createDefaultModules().map((m) => (m.name === 'identity' ? createIdentityModule({ bootstrap: false }) : m));
  const errors: string[] = [];
  const log: Logger = opts.captureErrors
    ? createLogger({ level: 'error', sink: (line) => errors.push(line) })
    : silentLogger;
  const aoc = await createAocServer(config, {
    log,
    clock,
    masterKey,
    webDir: null,
    modules: opts.modules ? opts.modules(list) : list,
  });
  const ids = identityTestHelpers(identityServiceOf(aoc.runtime.services));
  return {
    aoc,
    store: aoc.runtime.store,
    clock,
    dir,
    masterKey,
    ids,
    config,
    errors,
    user: (role, name, o) => ids.user(role, name, o),
    async request(method, path, init = {}) {
      const headers: Record<string, string> = { ...init.headers };
      let body: string | undefined;
      if (init.body !== undefined) {
        headers['content-type'] ??= 'application/json';
        body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
      }
      return aoc.app.request(path, { method, headers, body });
    },
    async close() {
      await aoc.close();
      if (ownDir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface SeededSession {
  sessionId: string;
  claudeSessionId: string;
  projectId: string;
  threadId: string;
}

/** A running managed session in the log, as the supervisor would have recorded its launch. */
export function seedSession(
  p: Pick<Prod, 'store'>,
  o: { sessionId: string; ownerId: string | null; projectId?: string; threadId?: string; claudeSessionId?: string; processType?: string },
): SeededSession {
  const projectId = o.projectId ?? 'prj_seed';
  const threadId = o.threadId ?? `thr_${o.sessionId}`;
  const h = createHash('sha256').update(o.sessionId).digest('hex');
  const claudeSessionId = o.claudeSessionId ?? `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  const scope = { sessionId: o.sessionId, projectId, threadId };
  const sup = { kind: 'system' as const, id: 'supervisor' };
  p.store.append({
    type: 'session.launch_requested',
    actor: sup,
    scope,
    meta: {
      sessionId: o.sessionId,
      projectId,
      threadId,
      processType: o.processType ?? 'discovery',
      model: 'claude-opus-5-5',
      readOnly: false,
      credentialProfile: null,
      ticketId: null,
      parentSessionId: null,
      phaseId: null,
      ownerId: o.ownerId,
    },
    payload: { prompt: 'Seeded session', cwd: '/tmp/seed' },
    source: 'supervisor',
  });
  p.store.append({
    type: 'session.launched',
    actor: sup,
    scope: { sessionId: o.sessionId },
    meta: { sessionId: o.sessionId, claudeSessionId, pid: 4242, model: 'claude-opus-5-5', turn: 1 },
    payload: { cwd: '/tmp/seed', argv: [], transcriptPath: '/tmp/seed/t.jsonl' },
    source: 'supervisor',
  });
  p.store.append({
    type: 'session.lifecycle_changed',
    actor: sup,
    scope: { sessionId: o.sessionId },
    meta: { sessionId: o.sessionId, from: 'launching', to: 'running', reason: 'launched' },
    source: 'supervisor',
  });
  return { sessionId: o.sessionId, claudeSessionId, projectId, threadId };
}

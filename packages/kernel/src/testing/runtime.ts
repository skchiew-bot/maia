import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { AocConfigSchema, type AocConfig, type Role, type ServiceMap, type User } from '@aoc/contracts';
import { FakeClock } from '../clock';
import { silentLogger, type Logger } from '../logger';
import type { AocModule, AppEnv } from '../host/module';
import { AocRuntime } from '../host/runtime';
import { DevIdentityService } from './dev-identity';
import { FakeLlm } from './fake-llm';
import { MemorySessionDirectory, SimpleDecisionService } from './stubs';

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface TestRuntimeOptions {
  modules: AocModule[];
  config?: DeepPartial<AocConfig> & Record<string, unknown>;
  now?: string | number;
  /** Provide/override services before modules init (e.g. stubs for modules not under test). */
  services?: Partial<ServiceMap>;
  /** Use the in-memory DevIdentityService unless a module provides `identity`. Default true. */
  devIdentity?: boolean;
  log?: Logger;
  /** Persist to a temp dir instead of :memory: (needed for restart / file-based tests). */
  onDisk?: boolean;
}

export interface TestUser {
  user: User;
  token: string;
  headers: Record<string, string>;
}

export interface TestRuntime {
  rt: AocRuntime;
  app: Hono<AppEnv>;
  clock: FakeClock;
  config: AocConfig;
  llm: FakeLlm;
  identity: DevIdentityService | null;
  /** Present when no module provides `sessions` (add sessions for your tests). */
  sessions: MemorySessionDirectory | null;
  /** Present when no module provides `decisions`. */
  decisions: SimpleDecisionService | null;
  dataDir: string;
  /** Create a user with a role; returns auth headers for app.request. */
  user(role: Role, name?: string, opts?: { complianceLead?: boolean }): TestUser;
  /** Ingest headers for a session (session token) or the observer. */
  ingestHeaders(sessionId: string | 'observer' | 'system'): Record<string, string>;
  /** Ingest headers of a session's sidecar (its heartbeats, activity, usage, throttles and process exits). */
  sidecarHeaders(sessionId: string): Record<string, string>;
  request(method: string, path: string, opts?: { headers?: Record<string, string>; body?: unknown }): Promise<Response>;
  json<T = unknown>(method: string, path: string, opts?: { headers?: Record<string, string>; body?: unknown; expect?: number }): Promise<T>;
  drain(): Promise<void>;
  close(): Promise<void>;
}

/** Spin up a full runtime (store, modules, services, routes) for module tests. */
export async function createTestRuntime(opts: TestRuntimeOptions): Promise<TestRuntime> {
  const dataDir = opts.onDisk ? mkdtempSync(join(tmpdir(), 'aoc-test-')) : ':memory:';
  const workDir = mkdtempSync(join(tmpdir(), 'aoc-work-'));
  const config = AocConfigSchema.parse({
    dataDir,
    ...opts.config,
    supervisor: { workspacesDir: join(workDir, 'workspaces'), ...(opts.config?.supervisor as object) },
    audit: { anchorRepoPath: join(workDir, 'anchor'), ...(opts.config?.audit as object) },
    selfModification: { externalAuditLog: join(workDir, 'selfmod.log'), ...(opts.config?.selfModification as object) },
  });
  const clock = new FakeClock(opts.now ?? '2026-10-09T02:00:00.000Z');
  const llm = new FakeLlm();
  const wantsDevIdentity = opts.devIdentity ?? true;
  let identity: DevIdentityService | null = null;
  let sessions: MemorySessionDirectory | null = null;
  let decisions: SimpleDecisionService | null = null;

  const pre: AocModule = {
    name: 'test-preamble',
    init(ctx) {
      for (const [k, v] of Object.entries(opts.services ?? {})) ctx.services.override(k as keyof ServiceMap, v as never);
      if (!ctx.services.has('llm')) ctx.services.provide('llm', llm);
    },
  };
  const post: AocModule = {
    name: 'test-identity',
    init(ctx) {
      if (wantsDevIdentity && !ctx.services.has('identity')) {
        identity = new DevIdentityService(ctx.store);
        ctx.services.provide('identity', identity);
      }
      if (!ctx.services.has('sessions')) {
        sessions = new MemorySessionDirectory();
        ctx.services.provide('sessions', sessions);
      }
      if (!ctx.services.has('decisions')) {
        decisions = new SimpleDecisionService(ctx.store, ctx.clock, () => ctx.services.maybe('identity'));
        ctx.services.provide('decisions', decisions);
      }
    },
  };
  const rt = await AocRuntime.create({
    config,
    modules: [pre, ...opts.modules, post],
    clock,
    log: opts.log ?? silentLogger,
    masterKey: randomBytes(32),
    dataDir,
  });
  const app = rt.mount(new Hono<AppEnv>());

  const t: TestRuntime = {
    rt,
    app,
    clock,
    config,
    llm,
    identity,
    sessions,
    decisions,
    dataDir,
    user(role, name, uopts) {
      if (!identity) throw new Error('user() needs the DevIdentityService; with mod-identity use its own helpers');
      const { user, token } = identity.createUser({ role, name, complianceLead: uopts?.complianceLead });
      return { user, token, headers: { authorization: `Bearer ${token}` } };
    },
    ingestHeaders(sessionId) {
      if (!identity) throw new Error('ingestHeaders() needs the DevIdentityService');
      const token =
        sessionId === 'observer'
          ? identity.issueObserverToken()
          : sessionId === 'system'
            ? identity.issueSystemToken()
            : identity.issueIngestToken(sessionId, { kind: 'system', id: 'test' });
      return { authorization: `Bearer ${token}` };
    },
    sidecarHeaders(sessionId) {
      if (!identity) throw new Error('sidecarHeaders() needs the DevIdentityService');
      return { authorization: `Bearer ${identity.issueSidecarToken(sessionId, { kind: 'system', id: 'test' })}` };
    },
    async request(method, path, ropts = {}) {
      const headers: Record<string, string> = { ...ropts.headers };
      let body: string | undefined;
      if (ropts.body !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(ropts.body);
      }
      return app.request(path, { method, headers, body });
    },
    async json(method, path, ropts = {}) {
      const res = await t.request(method, path, ropts);
      const text = await res.text();
      const expect = ropts.expect ?? 200;
      if (res.status !== expect) throw new Error(`${method} ${path} → ${res.status} (expected ${expect}): ${text}`);
      return (text ? JSON.parse(text) : null) as never;
    },
    drain: () => rt.drain(),
    async close() {
      await rt.stop();
      if (opts.onDisk) rmSync(dataDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    },
  };
  // The identity is created during init; expose it after runtime creation.
  t.identity = identity;
  t.sessions = sessions;
  t.decisions = decisions;
  return t;
}

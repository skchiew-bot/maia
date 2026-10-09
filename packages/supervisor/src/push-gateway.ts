/**
 * The push gateway (§3, R-02). A session holds no credential that can push, so a builder cannot make the model print
 * one. The session pushes over git's smart HTTP to aocd — `git push aoc <branch>`, remote `aoc` being
 * `<publicUrl>/ingest/git/<project>.git`, authenticated by the session's ingest token and only while one of its
 * turns runs — into a service-owned bare repository. The supervisor checks every ref against the session's
 * credential profile (`push.refs`; never a default or release branch, a tag or a deletion) and forwards the allowed
 * ones upstream itself, with the credential it alone holds, to the remote an operator configured on that
 * repository (`git --git-dir=<repo> remote add origin <url>`): never anywhere the session's own config points.
 *
 * The repository is `<dataDir>/git/<project>.git`, the path mod-change's service-owned clone uses for promotions
 * (G-04), so one `origin` serves feature pushes and promotions alike (each with its own credential profile).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { MAX_PUSH_BYTES, transportOf, type Actor, type GitTransport } from '@aoc/contracts';
import { GIT_SAFETY_ARGS, GIT_SERVICE_ENV, runServiceGit, serviceGitEnv, type Logger } from '@aoc/kernel';

// ── pkt-lines (gitprotocol-common) ────────────────────────────────────────────

const MAX_PKT = 65520;

export function pkt(data: string | Buffer): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii'), body]);
}
export const FLUSH = Buffer.from('0000', 'ascii');

export class GatewayError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 413 | 429 | 503,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** pkt-line payloads up to the first flush, the bytes they took, and whether the flush was found. */
export function readPktLines(buf: Buffer): { lines: Buffer[]; consumed: number; flushed: boolean } {
  const lines: Buffer[] = [];
  let at = 0;
  while (buf.length - at >= 4) {
    const hex = buf.toString('latin1', at, at + 4);
    if (!/^[0-9a-f]{4}$/.test(hex)) throw new GatewayError(400, 'malformed pkt-line');
    const len = parseInt(hex, 16);
    if (len === 0) return { lines, consumed: at + 4, flushed: true };
    if (len < 4 || len > MAX_PKT) throw new GatewayError(400, 'malformed pkt-line');
    if (buf.length - at < len) break;
    lines.push(buf.subarray(at + 4, at + len));
    at += len;
  }
  return { lines, consumed: at, flushed: false };
}

const ZERO_ID = /^0+$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface RefUpdate {
  oldSha: string;
  newSha: string;
  ref: string;
}

export interface PushCommands {
  updates: RefUpdate[];
  capabilities: string[];
  /** A shallow clone's boundary commits, sent ahead of the commands. */
  shallow: string[];
}

/** The commands of a push request (`<old> <new> <ref>`, capabilities after a NUL on the first). */
export function parseCommands(lines: Buffer[]): PushCommands {
  const updates: RefUpdate[] = [];
  const shallow: string[] = [];
  let capabilities: string[] = [];
  for (const raw of lines) {
    let line = raw.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('shallow ')) {
      const id = line.slice(8);
      if (updates.length || !OBJECT_ID.test(id)) throw new GatewayError(400, 'malformed push command');
      shallow.push(id);
      continue;
    }
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      if (updates.length === 0) capabilities = line.slice(nul + 1).split(' ').filter(Boolean);
      line = line.slice(0, nul);
    }
    const [oldSha, newSha, ref, ...more] = line.split(' ');
    if (!oldSha || !newSha || !ref || more.length || !OBJECT_ID.test(oldSha) || !OBJECT_ID.test(newSha))
      throw new GatewayError(400, 'malformed push command');
    updates.push({ oldSha, newSha, ref });
  }
  return { updates, capabilities, shallow };
}

/**
 * What the gateway lets a client negotiate: plain report-status and the pack format. No side band (so the report can
 * be rewritten), no atomic or push options, no ref deletion.
 */
const KEPT_CAPABILITIES = (c: string) => c === 'report-status' || c === 'ofs-delta' || c.startsWith('object-format=');

/**
 * The command section receive-pack is given: rebuilt from what was checked, with only the capabilities the gateway
 * speaks. What the policy approved is exactly what git executes, whatever else the client wrote on the wire.
 */
export function commandSection(c: PushCommands): Buffer {
  const caps = c.capabilities.filter(KEPT_CAPABILITIES);
  return Buffer.concat([
    ...c.shallow.map((id) => pkt(`shallow ${id}`)),
    ...c.updates.map((u, i) => pkt(`${u.oldSha} ${u.newSha} ${u.ref}${i === 0 && caps.length ? `\0${caps.join(' ')}` : ''}`)),
    FLUSH,
  ]);
}

/** receive-pack's ref advertisement with the capability list on its first line cut down to what the gateway speaks. */
export function filterAdvertisement(adv: Buffer): Buffer {
  const { lines } = readPktLines(adv);
  const first = lines[0];
  if (!first) return adv;
  const text = first.toString('utf8');
  const nul = text.indexOf('\0');
  if (nul < 0) return adv;
  const caps = text
    .slice(nul + 1)
    .replace(/\n$/, '')
    .split(' ')
    .filter(KEPT_CAPABILITIES);
  const rewritten = pkt(`${text.slice(0, nul)}\0${[...caps, 'agent=aoc-push-gateway'].join(' ')}\n`);
  return Buffer.concat([rewritten, adv.subarray(4 + first.length)]);
}

const advertisementHead = (service: string) => Buffer.concat([pkt(`# service=${service}\n`), FLUSH]);

/** The advertisement git prints as `fatal: remote error: <message>`: how a refusal reaches the model readably. */
export function advertisementError(message: string, service = 'git-receive-pack'): Buffer {
  return Buffer.concat([advertisementHead(service), pkt(`ERR ${oneLine(message)}\n`), FLUSH]);
}

/** A report-status (v1) answer: `unpack <status>`, then `ok <ref>` / `ng <ref> <reason>` per update. */
export function reportStatus(unpack: string, results: { ref: string; refusal: string | null }[]): Buffer {
  return Buffer.concat([
    pkt(`unpack ${unpack}\n`),
    ...results.map((r) => pkt(r.refusal === null ? `ok ${r.ref}\n` : `ng ${r.ref} ${oneLine(r.refusal)}\n`)),
    FLUSH,
  ]);
}

/** receive-pack's own report: whether it unpacked, and the refs it updated. */
export function parseReport(out: Buffer): { unpack: string | null; ok: Set<string>; ng: Map<string, string> } {
  const { lines } = readPktLines(out);
  let unpack: string | null = null;
  const ok = new Set<string>();
  const ng = new Map<string, string>();
  for (const raw of lines) {
    const line = raw.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('unpack ')) unpack = line.slice(7);
    else if (line.startsWith('ok ')) ok.add(line.slice(3));
    else if (line.startsWith('ng ')) {
      const rest = line.slice(3);
      const sp = rest.indexOf(' ');
      ng.set(sp < 0 ? rest : rest.slice(0, sp), sp < 0 ? 'refused' : rest.slice(sp + 1));
    }
  }
  return { unpack, ok, ng };
}

function oneLine(s: string): string {
  return s.replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 200) || 'refused';
}

// ── policy ────────────────────────────────────────────────────────────────────

/** The session's own ids, which `push.refs` patterns may name as placeholders. */
export interface PushVars {
  sessionId: string;
  projectId: string;
  threadId: string;
  ticketId: string | null;
}

/**
 * Default and release branches move only through the supervisor's gated promotion (§3, §8), whatever a profile says,
 * and so does what AOC itself keeps in the service clone (rollback evidence branches). Case-insensitive: a host or a
 * checkout on a case-folding file system must not turn `Main` into `main`.
 */
const PROTECTED_BRANCH = /^refs\/heads\/(?:main|master|production|HEAD|release(?:\/.*)?|aoc\/rollback(?:\/.*)?)$/i;

/** git check-ref-format, for the branches the gateway accepts at all. */
function validBranchRef(ref: string): boolean {
  if (!ref.startsWith('refs/heads/') || Buffer.byteLength(ref) > 255) return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(ref) || ref.includes('..') || ref.includes('@{') || ref.includes('//')) return false;
  if (ref.endsWith('/') || ref.endsWith('.')) return false;
  return ref.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
}

function globRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*' && pattern[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (ch === '*') re += '[^/]*';
    else re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** A pattern with the session's ids filled in; null when it names an id the session does not have (or one that is a glob). */
export function expandPattern(pattern: string, vars: PushVars): string | null {
  let missing = false;
  const out = pattern.replace(/\{(sessionId|projectId|threadId|ticketId)\}/g, (_, k: keyof PushVars) => {
    const v = vars[k];
    if (!v || v.includes('*')) missing = true;
    return v ?? '';
  });
  return missing ? null : out;
}

/** Why `u` may not be pushed by a session whose profile allows `patterns`, or null when it may. */
export function refusalOf(u: RefUpdate, patterns: readonly string[], vars: PushVars): string | null {
  if (ZERO_ID.test(u.newSha)) return 'aoc: deleting a branch through the gateway is not allowed';
  if (!validBranchRef(u.ref)) return 'aoc: only branches (refs/heads/...) can be pushed';
  if (PROTECTED_BRANCH.test(u.ref)) return 'aoc: protected branch; it moves only through a gated promotion';
  const allowed = patterns.some((p) => {
    const expanded = expandPattern(p, vars);
    return expanded !== null && globRegExp(expanded).test(u.ref);
  });
  return allowed ? null : "aoc: not a branch this session's credential profile may push";
}

/** At most `max` events per `windowMs` per key, on the injected clock. */
export class SlidingWindow {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}

  /** 0 when allowed (and counted), else the ms until the oldest hit leaves the window. */
  take(key: string): number {
    const now = this.now();
    const live = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (live.length >= this.max) {
      this.hits.set(key, live);
      return live[0]! + this.windowMs - now;
    }
    live.push(now);
    this.hits.set(key, live);
    return 0;
  }

  forget(key: string): void {
    this.hits.delete(key);
  }
}

// ── git ───────────────────────────────────────────────────────────────────────

/**
 * Settings on every git process the gateway runs, ahead of the repository's own config: the kernel's safety settings
 * (no hook, fsmonitor, signing program or automatic gc; every transport denied), then what a receiving end adds:
 * incoming objects are checked and bounded; no deletion, no non-fast-forward.
 */
const gitArgs = (maxPackBytes: number): string[] => [
  ...GIT_SAFETY_ARGS,
  ...Object.entries({
    'receive.autogc': 'false',
    'receive.fsckObjects': 'true',
    'transfer.fsckObjects': 'true',
    'receive.maxInputSize': String(maxPackBytes),
    'receive.denyDeletes': 'true',
    'receive.denyNonFastForwards': 'true',
    'receive.advertisePushOptions': 'false',
  }).flatMap(([k, v]) => ['-c', `${k}=${v}`]),
];
/** AOC's own refs (mod-change's targets, tags, rollback evidence) are neither advertised nor updatable through the gateway. */
const HIDDEN_REFS = ['refs/aoc', 'refs/tags', 'refs/heads/aoc/rollback'].flatMap((r) => ['-c', `receive.hideRefs=${r}`]);

const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** `<root>/<projectId>.git`, or a hash of the id when it is not a plain name (the name mod-change's clone uses). */
export function serviceRepoPathFor(root: string, projectId: string): string {
  const name = PLAIN_ID.test(projectId)
    ? projectId
    : `p-${createHash('sha256').update(projectId).digest('hex').slice(0, 32)}`;
  return join(resolve(root), `${name}.git`);
}

/** The lines of `git push --porcelain`: `<flag>\t<src>:<dst>\t<summary>`, by destination ref. */
export function parsePorcelain(stdout: string): Map<string, { ok: boolean; summary: string }> {
  const out = new Map<string, { ok: boolean; summary: string }>();
  for (const line of stdout.split('\n')) {
    const m = /^([ +\-*!=])\t[^\t]*:([^\t]+)\t(.*)$/.exec(line);
    if (m) out.set(m[2]!, { ok: m[1] !== '!', summary: m[3]! });
  }
  return out;
}

// ── the gateway ───────────────────────────────────────────────────────────────

/** Who may push, as the supervisor sees them. */
export type PushPrincipal =
  | { ok: true; vars: PushVars; actor: Actor; profileName: string; patterns: string[] | null }
  | { ok: false; status: 403 | 404 | 503; reason: string };

export interface PushRecord {
  vars: PushVars;
  profileName: string;
  results: { ref: string; oldSha: string; newSha: string; result: 'forwarded' | 'refused' | 'failed'; reason: string | null }[];
}

export interface PushGatewayHost {
  /** The session `sessionId`, if it may push to the repository `repoName` (`<name>.git`) right now. */
  principal(sessionId: string, repoName: string): PushPrincipal;
  /** The upstream push, run from the service repository with the named profile's credential (runIsolated). */
  forward(input: {
    repo: string;
    command: string[];
    env: Record<string, string>;
    profileName: string;
    timeoutMs: number;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  record(r: PushRecord): void;
  env(): Record<string, string | undefined>;
  now(): number;
  log: Logger;
}

export interface PushGatewayOptions {
  /** Where the service-owned repositories live (`<dataDir>/git`). */
  root: string;
  /** Deadline of one upstream push (default 2 min). */
  forwardTimeoutMs?: number;
  /** Pushes one session may make per window (default 30 per 10 minutes). */
  pushesPerWindow?: number;
  windowMs?: number;
  /** Largest pack one push may carry (default MAX_PUSH_BYTES; git's receive.maxInputSize). */
  maxPackBytes?: number;
  /** A push request that sends nothing for this long is dropped, so a stalled one cannot hold its project's lock (default 60 s). */
  idleTimeoutMs?: number;
}

const MAX_HEAD_BYTES = 1024 * 1024;
const MAX_UPDATES = 100;

export class PushGateway {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly limit: SlidingWindow;
  private readonly gitArgs: string[];

  constructor(
    private readonly host: PushGatewayHost,
    private readonly o: PushGatewayOptions,
  ) {
    this.limit = new SlidingWindow(o.pushesPerWindow ?? 30, o.windowMs ?? 10 * 60_000, () => host.now());
    this.gitArgs = gitArgs(o.maxPackBytes ?? MAX_PUSH_BYTES);
  }

  repoName(projectId: string): string {
    return basename(serviceRepoPathFor(this.o.root, projectId));
  }

  /** The service repository of a project (created at its first push). */
  repoPath(projectId: string): string {
    return serviceRepoPathFor(this.o.root, projectId);
  }

  /** GET info/refs?service=git-receive-pack: the repository's branches, and what a client may negotiate. */
  async advertise(sessionId: string, repoName: string): Promise<Buffer> {
    const p = this.principalOrThrow(sessionId, repoName);
    const repo = this.ensureRepo(p.vars.projectId);
    const r = await this.git(repo, [...HIDDEN_REFS, 'receive-pack', '--stateless-rpc', '--advertise-refs', repo]);
    if (r.code !== 0) throw new GatewayError(503, 'the push gateway repository is not usable');
    return Buffer.concat([advertisementHead('git-receive-pack'), filterAdvertisement(r.stdout)]);
  }

  /** POST git-receive-pack: check, receive into the service repository, forward upstream, report per ref. */
  async receive(sessionId: string, repoName: string, body: ReadableStream<Uint8Array> | null): Promise<Buffer> {
    const p = this.principalOrThrow(sessionId, repoName);
    const source = (body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() })).getReader();
    // Bounded after gzip too: a few KiB of compressed zeros must not keep aocd decompressing for minutes.
    const reader = guarded(source, (this.o.maxPackBytes ?? MAX_PUSH_BYTES) + 2 * MAX_HEAD_BYTES, this.o.idleTimeoutMs ?? 60_000);
    try {
      const head = await readHead(reader);
      const commands = parseCommands(head.lines);
      const { updates, capabilities } = commands;
      // An empty command list is git's probe before a large push (or a push with nothing to do).
      if (!updates.length) return Buffer.alloc(0);
      if (updates.length > MAX_UPDATES) throw new GatewayError(400, `at most ${MAX_UPDATES} refs per push`);
      const wait = this.limit.take(sessionId);
      if (wait) throw new GatewayError(429, 'too many pushes from this session; wait before pushing again', wait);
      const answer = (buf: Buffer) => (capabilities.includes('report-status') ? buf : Buffer.alloc(0));
      const refusals = updates.map((u) =>
        p.patterns === null
          ? `aoc: credential profile ${p.profileName} allows no pushes (it has no push.refs)`
          : refusalOf(u, p.patterns, p.vars),
      );
      if (refusals.some((r) => r !== null)) {
        await drain(reader);
        // All or nothing: a push is accepted whole or refused whole, so no branch moves half-way.
        const results = updates.map((u, i) => ({
          ref: u.ref,
          refusal: refusals[i] ?? 'aoc: refused with the rest of this push',
        }));
        this.record(p, updates, results.map((r) => ({ result: 'refused' as const, reason: r.refusal })));
        return answer(reportStatus('ok', results));
      }
      return answer(await this.locked(p.vars.projectId, () => this.receiveAndForward(p, commands, head.rest, reader)));
    } finally {
      try {
        source.releaseLock();
      } catch {
        // A stalled read is still pending (older runtimes refuse to release then): the body goes with the request.
      }
    }
  }

  private async receiveAndForward(
    p: Extract<PushPrincipal, { ok: true }>,
    commands: PushCommands,
    rest: Buffer,
    reader: BodyReader,
  ): Promise<Buffer> {
    const { updates } = commands;
    const repo = this.ensureRepo(p.vars.projectId);
    const upstream = this.upstreamOf(repo);
    if (!upstream.ok) {
      this.host.log.warn('push gateway: the service repository has no usable upstream remote', { repo, reason: upstream.reason });
      await drain(reader);
      this.record(p, updates, updates.map(() => ({ result: 'refused' as const, reason: upstream.reason })));
      return reportStatus('ok', updates.map((u) => ({ ref: u.ref, refusal: upstream.reason })));
    }
    const received = await this.receivePack(repo, commandSection(commands), rest, reader);
    const report = parseReport(received.stdout);
    if (report.unpack !== 'ok') {
      this.host.log.warn('push gateway: receive-pack failed', { sessionId: p.vars.sessionId, code: received.code });
      const reason = 'aoc: the push could not be received (corrupt, over the size limit, or failing git fsck)';
      this.record(p, updates, updates.map(() => ({ result: 'failed' as const, reason })));
      return reportStatus('error', updates.map((u) => ({ ref: u.ref, refusal: reason })));
    }
    const accepted = updates.filter((u) => report.ok.has(u.ref));
    const forwarded = accepted.length
      ? await this.forward(p, repo, upstream, accepted)
      : new Map<string, string | null>();
    const outcomes = updates.map((u) => {
      if (!report.ok.has(u.ref)) return { result: 'refused' as const, reason: `aoc: ${report.ng.get(u.ref) ?? 'refused'}` };
      const failure = forwarded.get(u.ref) ?? null;
      return failure === null
        ? { result: 'forwarded' as const, reason: null }
        : { result: 'failed' as const, reason: failure };
    });
    // The service repository mirrors what upstream accepted: a branch upstream refused goes back to where it was.
    for (const [i, u] of updates.entries()) if (outcomes[i]!.result === 'failed') await this.restoreRef(repo, u);
    this.record(p, updates, outcomes);
    return reportStatus('ok', updates.map((u, i) => ({ ref: u.ref, refusal: outcomes[i]!.reason })));
  }

  /** One push of the accepted refs to the configured remote, never forced, with the profile's credential. */
  private async forward(
    p: Extract<PushPrincipal, { ok: true }>,
    repo: string,
    upstream: { url: string; transport: 'ssh' | 'https' | 'file' },
    accepted: RefUpdate[],
  ): Promise<Map<string, string | null>> {
    // Like the promotion push from the same clone: the URL itself, one transport opened, a fixed environment.
    const command = [
      'git',
      ...this.gitArgs,
      '-c',
      `protocol.${upstream.transport}.allow=user`,
      `--git-dir=${repo}`,
      'push',
      '--porcelain',
      '--no-verify',
      '--',
      upstream.url,
      ...accepted.map((u) => `${u.newSha}:${u.ref}`),
    ];
    let r: { exitCode: number; stdout: string; stderr: string };
    try {
      r = await this.host.forward({
        repo,
        command,
        env: { ...GIT_SERVICE_ENV },
        profileName: p.profileName,
        timeoutMs: this.o.forwardTimeoutMs ?? 120_000,
      });
    } catch (err) {
      this.host.log.error('push gateway: the upstream push could not run', { sessionId: p.vars.sessionId, err: String(err) });
      return new Map(accepted.map((u) => [u.ref, 'aoc: the upstream push could not run (see the aocd log)']));
    }
    const lines = parsePorcelain(r.stdout);
    if (r.exitCode !== 0 && !lines.size)
      this.host.log.warn('push gateway: the upstream push failed', { sessionId: p.vars.sessionId, exitCode: r.exitCode });
    return new Map(
      accepted.map((u) => {
        const line = lines.get(u.ref);
        if (line?.ok) return [u.ref, null];
        // Never relay git's stderr: it can carry the remote URL and whatever credential is embedded in it.
        return [u.ref, line ? `aoc: upstream ${oneLine(line.summary)}` : 'aoc: the upstream push failed (see the aocd log)'];
      }),
    );
  }

  private principalOrThrow(sessionId: string, repoName: string): Extract<PushPrincipal, { ok: true }> {
    const p = this.host.principal(sessionId, repoName);
    if (!p.ok) throw new GatewayError(p.status, p.reason);
    return p;
  }

  private ensureRepo(projectId: string): string {
    const repo = serviceRepoPathFor(this.o.root, projectId);
    if (!existsSync(repo)) {
      mkdirSync(dirname(repo), { recursive: true, mode: 0o700 });
      // Created the way mod-change's service clone is, so whichever comes first leaves the other the same repository.
      const r = runServiceGit(dirname(repo), [
        'init',
        '--quiet',
        '--bare',
        '--template=',
        '--initial-branch=aoc-service-clone',
        repo,
      ]);
      if (r.code !== 0) throw new GatewayError(503, 'the push gateway repository could not be created');
    }
    return repo;
  }

  /** The operator-configured remote of the service repository (pushurl wins), and how git would reach it. */
  private upstreamOf(
    repo: string,
  ): { ok: true; url: string; transport: GitTransport } | { ok: false; reason: string } {
    for (const key of ['remote.origin.pushurl', 'remote.origin.url']) {
      const r = runServiceGit(repo, [`--git-dir=${repo}`, 'config', '--get', key]);
      const url = r.code === 0 ? r.stdout.trim() : '';
      if (!url) continue;
      const transport = transportOf(url);
      return transport
        ? { ok: true, url, transport }
        : { ok: false, reason: 'aoc: the upstream remote is not an ssh, https or local-path URL' };
    }
    return {
      ok: false,
      reason: 'aoc: no upstream remote is configured for this project (operator: git --git-dir=<service repo> remote add origin <url>)',
    };
  }

  /** git receive-pack --stateless-rpc, fed the request as it arrives (never buffered whole). */
  private async receivePack(
    repo: string,
    commands: Buffer,
    rest: Buffer,
    reader: BodyReader,
  ): Promise<{ code: number; stdout: Buffer }> {
    const child = spawn('git', [...this.gitArgs, ...HIDDEN_REFS, 'receive-pack', '--stateless-rpc', repo], {
      env: serviceGitEnv({}, this.host.env()),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const out: Buffer[] = [];
    let size = 0;
    child.stdout.on('data', (b: Buffer) => {
      if ((size += b.length) <= MAX_HEAD_BYTES) out.push(b);
    });
    const closed = new Promise<number>((ok) => child.on('close', (code) => ok(code ?? 1)));
    child.on('error', () => undefined);
    child.stdin.on('error', () => undefined); // receive-pack may stop reading early (it reports why)
    // receive-pack stops reading when it has seen enough (a pack over the limit): the rest of the request is dropped
    // here, not turned into an error; its exit code and report say why.
    const write = async (b: Uint8Array) => {
      if (!child.stdin.writable) return;
      if (child.stdin.write(b)) return;
      await new Promise<void>((ok) => {
        const done = () => {
          child.stdin.off('drain', done);
          child.stdin.off('error', done);
          ok();
        };
        child.stdin.once('drain', done);
        child.stdin.once('error', done);
        void closed.then(done);
      });
    };
    try {
      await write(commands);
      if (rest.length) await write(rest);
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        await write(value);
      }
    } catch (err) {
      // The request broke off (or tripped the body cap): receive-pack updates no ref without the whole pack.
      child.kill('SIGKILL');
      await closed;
      throw err;
    }
    child.stdin.end();
    return { code: await closed, stdout: Buffer.concat(out) };
  }

  /** Puts a ref of the service repository back where it was before this push. */
  private async restoreRef(repo: string, u: RefUpdate): Promise<void> {
    const args = ZERO_ID.test(u.oldSha) ? ['update-ref', '-d', u.ref, u.newSha] : ['update-ref', u.ref, u.oldSha, u.newSha];
    const r = await this.git(repo, args);
    if (r.code !== 0) this.host.log.warn('push gateway: could not restore a ref after an upstream refusal', { code: r.code });
  }

  private git(repo: string, args: string[]): Promise<{ code: number; stdout: Buffer }> {
    return new Promise((ok) => {
      const child = spawn('git', [...this.gitArgs, `--git-dir=${repo}`, ...args], {
        env: serviceGitEnv({}, this.host.env()),
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const out: Buffer[] = [];
      child.stdout.on('data', (b: Buffer) => out.push(b));
      child.on('error', () => ok({ code: 1, stdout: Buffer.alloc(0) }));
      child.on('close', (code) => ok({ code: code ?? 1, stdout: Buffer.concat(out) }));
    });
  }

  /** One push at a time per project: receive, forward and restore never interleave on the same repository. */
  private locked<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(projectId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(projectId, tail);
    void tail.then(() => {
      if (this.locks.get(projectId) === tail) this.locks.delete(projectId);
    });
    return run;
  }

  private record(
    p: Extract<PushPrincipal, { ok: true }>,
    updates: RefUpdate[],
    outcomes: { result: 'forwarded' | 'refused' | 'failed'; reason: string | null }[],
  ): void {
    this.host.record({
      vars: p.vars,
      profileName: p.profileName,
      results: updates.map((u, i) => ({ ...u, result: outcomes[i]!.result, reason: outcomes[i]!.reason })),
    });
  }
}

/** What the gateway needs of a request body. */
interface BodyReader {
  read(): Promise<{ done: false; value: Uint8Array } | { done: true; value?: Uint8Array }>;
}

/**
 * A request body that fails closed: more than `limit` bytes (counted after any gzip), or silence for longer than
 * `idleMs`, ends the request. The latter keeps a client that stalls from holding its project's push lock.
 */
function guarded(source: ReadableStreamDefaultReader<Uint8Array>, limit: number, idleMs: number): BodyReader {
  let total = 0;
  return {
    async read() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new GatewayError(400, 'the push request stalled')), idleMs);
      });
      try {
        const r = await Promise.race([source.read(), stalled]);
        if (!r.done && (total += r.value.byteLength) > limit) throw new GatewayError(413, 'the push is larger than the gateway accepts');
        return r;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** The command section of a push request (up to its flush), and the bytes read past it. */
async function readHead(reader: BodyReader): Promise<{ lines: Buffer[]; rest: Buffer }> {
  let buf = Buffer.alloc(0);
  for (;;) {
    const { lines, consumed, flushed } = readPktLines(buf);
    if (flushed) return { lines, rest: buf.subarray(consumed) };
    if (buf.length > MAX_HEAD_BYTES) throw new GatewayError(413, 'push command list too large');
    const { value, done } = await reader.read();
    if (done) {
      if (!buf.length) return { lines: [], rest: buf };
      throw new GatewayError(400, 'truncated push request');
    }
    buf = Buffer.concat([buf, value]);
  }
}

async function drain(reader: BodyReader): Promise<void> {
  for (;;) if ((await reader.read()).done) return;
}

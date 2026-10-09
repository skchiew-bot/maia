/**
 * The push gateway (R-02): a session holds no credential that can push; it pushes with plain `git push aoc …`
 * through the supervisor, which checks every ref against the session's credential profile and forwards the allowed
 * ones upstream with the credential only it holds. These tests run a real git client against the real routes over a
 * real socket, with a fake `claude` running the pushes as a model's Bash tool would, in its real environment.
 */
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { initRepo, silentLogger } from '@aoc/kernel';
import {
  FLUSH,
  PushGateway,
  commandSection,
  parseCommands,
  pkt,
  readPktLines,
  refusalOf,
  serviceRepoPathFor,
  type PushGatewayOptions,
} from '../src/push-gateway';
import { createHarness, SECRETS, type Harness } from './harness';
import type { SupervisorModuleOptions } from '../src';

const GIT_ENV = {
  PATH: process.env.PATH ?? '',
  HOME: tmpdir(),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};
const git = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...GIT_ENV, ...env } });
/** For a client that talks to this process's own HTTP server: spawnSync would block the event loop the server needs. */
const gitAsync = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  new Promise<{ status: number; stderr: string }>((ok) => {
    execFile('git', args, { cwd, encoding: 'utf8', env: { ...GIT_ENV, ...env } }, (err, _out, stderr) =>
      ok({ status: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stderr }),
    );
  });
const ref = (repo: string, name: string): string | null => {
  const r = git(repo, ['rev-parse', '--verify', '--quiet', name]);
  return r.status === 0 ? r.stdout.trim() : null;
};

/** The aocd HTTP surface on a real port, so a real git can talk to it. */
async function listen(): Promise<{ url: string; bind(f: (r: Request) => Response | Promise<Response>): void; close(): Promise<void> }> {
  let handler: ((r: Request) => Response | Promise<Response>) | null = null;
  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        if (!handler) throw new Error('no handler bound yet');
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers))
          if (v !== undefined && !['connection', 'keep-alive'].includes(k)) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
        const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : (Readable.toWeb(req) as ReadableStream<Uint8Array>);
        const response = await handler(
          new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body, duplex: 'half' } as RequestInit),
        );
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (err) {
        res.writeHead(500).end(String(err));
      }
    })();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    bind: (f) => (handler = f),
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

interface World {
  h: Harness;
  root: string;
  /** The project's repository: the agents' workspace. */
  repo: string;
  /** The protected remote ("GitHub"): what the gateway forwards to. */
  upstream: string;
  /** The gateway's service-owned repository for the project. */
  service: string;
  /** What the upstream's pre-receive hook saw of the pushing process's credential: `<GIT_PUSH_TOKEN>|<DEPLOY_TOKEN>`. */
  hookLog: string;
  /** While this file exists the upstream refuses every push. */
  rejectFlag: string;
  url: string;
  run(body: string, extra?: { processType?: string; ticketId?: string; threadId?: string }): Promise<{ id: string; out: { status: number | null; stdout: string; stderr: string } }>;
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function world(module: SupervisorModuleOptions = {}): Promise<World> {
  const server = await listen();
  const root = mkdtempSync(join(tmpdir(), 'aoc-gateway-'));
  const repo = join(root, 'workspace');
  initRepo(repo);
  const upstream = join(root, 'upstream.git');
  git(root, ['init', '-q', '--bare', upstream]);
  git(repo, ['push', '-q', upstream, 'HEAD:refs/heads/main']);
  const hookLog = join(root, 'hook-saw');
  const rejectFlag = join(root, 'reject');
  const hook = join(upstream, 'hooks', 'pre-receive');
  writeFileSync(
    hook,
    `#!/bin/sh\nprintf '%s|%s' "$GIT_PUSH_TOKEN" "$DEPLOY_TOKEN" > '${hookLog}'\nif [ -e '${rejectFlag}' ]; then echo 'upstream policy says no' >&2; exit 1; fi\n`,
  );
  chmodSync(hook, 0o755);
  // The operator's one-time step: the service repository, and where it forwards to.
  const gatewayDir = join(root, 'git');
  const service = serviceRepoPathFor(gatewayDir, 'prj_demo');
  mkdirSync(gatewayDir, { recursive: true });
  git(root, ['init', '-q', '--bare', '--template=', service]);
  git(root, [`--git-dir=${service}`, 'remote', 'add', 'origin', upstream]);

  const h = await createHarness({ config: { publicUrl: server.url }, module: { gatewayDir, ...module } });
  server.bind((r) => h.t.app.fetch(r));
  h.ledger.repoPaths.set('prj_demo', repo);
  closers.push(async () => {
    await h.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  let n = 0;
  return {
    h,
    root,
    repo,
    upstream,
    service,
    hookLog,
    rejectFlag,
    url: server.url,
    async run(body, extra = {}) {
      const script = join(root, `script-${++n}.sh`);
      const out = join(root, `out-${n}.json`);
      writeFileSync(script, `${body}\n`);
      const id = await h.launch(`[[fake:shell|script=${script}|out=${out}]] push it`, { cwd: repo, ...extra });
      await h.waitLifecycle(id, 'idle');
      return { id, out: JSON.parse(readFileSync(out, 'utf8')) };
    },
  };
}

const commit = (branch: string, file = 'work.txt') =>
  `git checkout -q -B ${branch}\necho "${branch}" > ${file}\ngit add ${file}\ngit commit -q -m "${branch}"`;

describe('a session pushes through the gateway and never holds the credential (R-02)', () => {
  it('forwards an allowed branch upstream with the credential aocd holds; the session has none of it', async () => {
    const w = await world();
    const { id, out } = await w.run(`${commit('feature/x')}\ngit push aoc HEAD:refs/heads/feature/x 2>&1`);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/\[new branch\]\s+HEAD -> feature\/x/);

    // upstream has the branch, and was reached by a process holding the credential only aocd has
    expect(ref(w.upstream, 'refs/heads/feature/x')).toBe(ref(w.repo, 'refs/heads/feature/x'));
    expect(readFileSync(w.hookLog, 'utf8')).toBe(`${SECRETS.gitFeature}|`);
    expect(ref(w.service, 'refs/heads/feature/x')).toBe(ref(w.upstream, 'refs/heads/feature/x'));

    // nothing of it was ever in the session: not its environment, not any file of its session directory
    const call = w.h.callsFor(id)[0]!;
    const held = [SECRETS.gitFeature, SECRETS.featureKey, 'GIT_PUSH_TOKEN', 'GIT_KEY_FILE', SECRETS.uatDeploy];
    for (const needle of held) expect(JSON.stringify(call.env), needle).not.toContain(needle);
    const files = readdirSync(join(w.h.sessionsDir, id), { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(join(f.parentPath, f.name), 'utf8');
      for (const needle of held) expect(text, `${f.name} holds ${needle}`).not.toContain(needle);
    }
    // what it does hold is the way in: a remote that is the gateway, and the session's own non-secret settings
    expect(call.env.GIT_CONFIG_VALUE_0).toBe(`${w.url}/ingest/git/prj_demo.git`);
    expect(call.env.NPM_READ_TOKEN).toBe(SECRETS.sessionRead);

    // the push is an event: counts in the clear chain, branch names only in the encrypted body
    const [pushed] = w.h.events('session.git_pushed', id);
    expect(pushed!.meta).toEqual({ sessionId: id, credentialProfile: 'git-feature', refs: 1, forwarded: 1, refused: 0, failed: 0 });
    expect(JSON.stringify(pushed!.meta)).not.toContain('feature/x');
    expect(w.h.payload(pushed!)).toMatchObject({
      results: [{ ref: 'refs/heads/feature/x', result: 'forwarded', reason: null }],
    });
    expect(w.h.t.rt.store.verifyChain().ok).toBe(true);
  }, 60_000);

  it('tells the model the remote, and the branches its profile allows with its own ids filled in', async () => {
    const w = await world();
    const { id } = await w.run('true', { threadId: 'thr_alpha' });
    const prompt = w.h.file(id, 'system-prompt.md');
    expect(prompt).toContain('git push aoc <commit>:refs/heads/<branch>');
    expect(prompt).toContain('`refs/heads/feature/**`');
    expect(prompt).toContain('`refs/heads/aoc/thr_alpha/**`');
    expect(prompt).toContain('you hold no credential for the upstream repository');
  }, 60_000);

  it('refuses main, release branches, unlisted branches, tags and deletions, and a push with any of them whole', async () => {
    const w = await world();
    const { out } = await w.run(
      `${commit('feature/ok')}
try() { echo "== $*"; git push aoc "$@" 2>&1; echo "exit=$?"; }
try HEAD:refs/heads/main
try HEAD:refs/heads/release/1
try HEAD:refs/heads/other
try HEAD:refs/tags/v1
try HEAD:refs/heads/feature/ok HEAD:refs/heads/main
try :refs/heads/feature/ok`,
    );
    const runs = Object.fromEntries(out.stdout.split('== ').filter(Boolean).map((r) => [r.split('\n', 1)[0]!, r]));
    const of = (cmd: string) => runs[cmd]!;
    expect(of('HEAD:refs/heads/main')).toMatch(/\(aoc: protected branch; it moves only through a gated promotion\)[\s\S]*exit=1/);
    expect(of('HEAD:refs/heads/release/1')).toMatch(/aoc: protected branch[\s\S]*exit=1/);
    expect(of('HEAD:refs/heads/other')).toMatch(/aoc: not a branch this session's credential profile may push[\s\S]*exit=1/);
    expect(of('HEAD:refs/tags/v1')).toMatch(/aoc: only branches \(refs\/heads\/\.\.\.\) can be pushed[\s\S]*exit=1/);
    // atomic: the allowed branch in a push that also names main goes nowhere either
    expect(of('HEAD:refs/heads/feature/ok HEAD:refs/heads/main')).toMatch(/aoc: refused with the rest of this push/);
    expect(of('HEAD:refs/heads/feature/ok HEAD:refs/heads/main')).toMatch(/aoc: protected branch/);
    // the gateway does not offer deletion, so the client stops before sending anything
    expect(of(':refs/heads/feature/ok')).toMatch(/exit=[1-9]/);

    expect(git(w.upstream, ['for-each-ref', '--format=%(refname)']).stdout.trim()).toBe('refs/heads/main');
    expect(git(w.service, ['for-each-ref', '--format=%(refname)']).stdout.trim()).toBe('');
    const pushes = w.h.events('session.git_pushed');
    expect(pushes.length).toBeGreaterThanOrEqual(5);
    expect(pushes.every((e) => e.meta.forwarded === 0)).toBe(true);
    expect(pushes[0]!.meta).toMatchObject({ refused: 1, failed: 0 });
  }, 90_000);

  it('expands the session’s own ids in the branches a profile allows (uat/<ticket> for that ticket only)', async () => {
    const w = await world();
    const { out, id } = await w.run(
      `${commit('uat/tkt_1')}
git branch -q uat/tkt_2
try() { echo "== $*"; git push aoc "$@" 2>&1; echo "exit=$?"; }
try HEAD:refs/heads/uat/tkt_1
try HEAD:refs/heads/uat/tkt_2
try HEAD:refs/heads/feature/x`,
      { processType: 'bug-fix', ticketId: 'tkt_1' },
    );
    const runs = Object.fromEntries(out.stdout.split('== ').filter(Boolean).map((r) => [r.split('\n', 1)[0]!, r]));
    expect(runs['HEAD:refs/heads/uat/tkt_1']).toMatch(/exit=0/);
    expect(runs['HEAD:refs/heads/uat/tkt_2']).toMatch(/aoc: not a branch this session's credential profile may push[\s\S]*exit=1/);
    expect(runs['HEAD:refs/heads/feature/x']).toMatch(/exit=1/);
    expect(git(w.upstream, ['for-each-ref', '--format=%(refname)', 'refs/heads/uat']).stdout.trim()).toBe('refs/heads/uat/tkt_1');
    // the other credential profile, the other credential
    expect(readFileSync(w.hookLog, 'utf8')).toBe(`|${SECRETS.uatDeploy}`);
    expect(JSON.stringify(w.h.callsFor(id)[0]!.env)).not.toContain(SECRETS.uatDeploy);
    expect(w.h.file(id, 'system-prompt.md')).toContain('`refs/heads/uat/tkt_1`');
  }, 90_000);

  it('gives a profile that names no push refs no remote, and so no way to push', async () => {
    const w = await world();
    const { id, out } = await w.run('git push aoc HEAD:refs/heads/feature/x 2>&1', { processType: 'held-only' });
    expect(out.status).not.toBe(0);
    expect(out.stdout).toMatch(/'aoc' does not appear to be a git repository|No configured push destination/);
    const call = w.h.callsFor(id)[0]!;
    expect(call.env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(JSON.stringify(call.env)).not.toContain(SECRETS.heldOnly);
    expect(w.h.events('session.git_pushed')).toEqual([]);
    expect(w.h.file(id, 'system-prompt.md')).not.toContain('git push aoc');
  }, 60_000);

  it('accepts a push only while a turn of the session is running, and only from a managed session on its own project', async () => {
    const w = await world();
    const { id } = await w.run(commit('feature/x'));
    const call = w.h.callsFor(id)[0]!;
    // The token and the remote are still in the transcript of the environment, but the turn is over.
    const sessionEnv = Object.fromEntries(Object.entries(call.env).filter(([k]) => k.startsWith('GIT_CONFIG_')));
    const late = await gitAsync(w.repo, ['push', 'aoc', 'HEAD:refs/heads/feature/x'], sessionEnv);
    expect(late.status).not.toBe(0);
    expect(late.stderr).toMatch(/remote error: aoc: pushes are accepted only while a turn of the session is running/);
    expect(ref(w.upstream, 'refs/heads/feature/x')).toBeNull();

    const url = '/ingest/git/prj_demo.git/info/refs?service=git-receive-pack';
    expect((await w.h.t.app.request(url)).status).toBe(401); // no token at all
    expect((await w.h.t.app.request(url, { headers: w.h.t.ingestHeaders('observer') })).status).toBe(403);
    expect((await w.h.t.app.request(url, { headers: w.h.t.ingestHeaders('system') })).status).toBe(403);
    // fetching through the gateway is not a thing either: pushes only
    const upload = await w.h.t.app.request('/ingest/git/prj_demo.git/info/refs?service=git-upload-pack', {
      headers: w.h.t.ingestHeaders(id),
    });
    expect(await upload.text()).toContain('ERR aoc: the gateway accepts pushes only');
    expect((await w.h.t.app.request('/ingest/git/prj_demo.git/info/refs', { headers: w.h.t.ingestHeaders(id) })).status).toBe(403);
  }, 60_000);

  it('keeps a session off another project’s repository, and its token off any other URL', async () => {
    const w = await world();
    const other = `${w.url}/ingest/git/prj_other.git`;
    const { out } = await w.run(
      `${commit('feature/x')}
echo "== scoped"; git push "${other}" HEAD:refs/heads/feature/x 2>&1
echo "== explicit"; git -c "http.${other}.extraHeader=Authorization: Bearer $AOC_INGEST_TOKEN" push "${other}" HEAD:refs/heads/feature/x 2>&1`,
    );
    const runs = Object.fromEntries(out.stdout.split('== ').filter(Boolean).map((r) => [r.split('\n', 1)[0]!, r]));
    // the header the gateway remote carries is scoped to that one URL by git's own config
    expect(runs.scoped).toMatch(/could not read Username/);
    expect(runs.explicit).toMatch(/remote error: aoc: not this session's repository/);
    expect(ref(w.upstream, 'refs/heads/feature/x')).toBeNull();
  }, 60_000);

  it('reports an upstream refusal to the model and leaves the service repository as it was', async () => {
    const w = await world();
    writeFileSync(w.rejectFlag, 'x');
    const { id, out } = await w.run(`${commit('feature/y')}\ngit push aoc HEAD:refs/heads/feature/y 2>&1`);
    expect(out.status).not.toBe(0);
    expect(out.stdout).toMatch(/\[remote rejected\] HEAD -> feature\/y \(aoc: upstream \[remote rejected\] \(pre-receive hook declined\)\)/);
    // git's own words never carry the remote's output back (it can echo a URL with a credential in it)
    expect(out.stdout).not.toContain('upstream policy says no');
    expect(ref(w.upstream, 'refs/heads/feature/y')).toBeNull();
    expect(ref(w.service, 'refs/heads/feature/y')).toBeNull();
    expect(w.h.events('session.git_pushed', id)[0]!.meta).toMatchObject({ forwarded: 0, refused: 0, failed: 1 });

    // and once upstream accepts again, the same push goes through
    rmSync(w.rejectFlag);
    const again = await w.run(`git checkout -q feature/y\ngit push aoc HEAD:refs/heads/feature/y 2>&1`);
    expect(again.out.status).toBe(0);
    expect(ref(w.upstream, 'refs/heads/feature/y')).toBe(ref(w.repo, 'refs/heads/feature/y'));
  }, 90_000);

  it('refuses to forward without an upstream remote of an allowed kind', async () => {
    const w = await world();
    git(w.root, [`--git-dir=${w.service}`, 'remote', 'remove', 'origin']);
    const none = await w.run(`${commit('feature/a')}\ngit push aoc HEAD:refs/heads/feature/a 2>&1`);
    expect(none.out.stdout).toMatch(/aoc: no upstream remote is configured for this project/);
    git(w.root, [`--git-dir=${w.service}`, 'remote', 'add', 'origin', 'ext::sh -c "touch /tmp/pwned"']);
    const ext = await w.run(`git push aoc HEAD:refs/heads/feature/a 2>&1`);
    expect(ext.out.stdout).toMatch(/aoc: the upstream remote is not an ssh, https or local-path URL/);
    expect(existsSync('/tmp/pwned')).toBe(false);
    expect(ref(w.service, 'refs/heads/feature/a')).toBeNull();
  }, 90_000);

  it('bounds the size of a push and the rate of pushes per session', async () => {
    const w = await world({ maxPackBytes: 100_000, pushesPerWindow: 3 });
    const big = await w.run(`${commit('feature/big')}\nhead -c 400000 /dev/urandom > big.bin\ngit add big.bin\ngit commit -q -m big\ngit push aoc HEAD:refs/heads/feature/big 2>&1`);
    expect(big.out.status).not.toBe(0);
    expect(ref(w.upstream, 'refs/heads/feature/big')).toBeNull();
    expect(ref(w.service, 'refs/heads/feature/big')).toBeNull();
    expect(w.h.events('session.git_pushed', big.id)[0]!.meta).toMatchObject({ forwarded: 0, failed: 1 });

    // three pushes per window per session: the fourth is told to wait, and nothing of it reaches upstream
    const { out } = await w.run(
      `git checkout -q feature/big~1
for i in 1 2 3 4; do git push aoc HEAD:refs/heads/feature/n$i 2>&1 | tail -n 3; done`,
    );
    expect(out.stdout).toMatch(/429/);
    for (const n of [1, 2, 3]) expect(ref(w.upstream, `refs/heads/feature/n${n}`), `n${n}`).not.toBeNull();
    expect(ref(w.upstream, 'refs/heads/feature/n4')).toBeNull();
  }, 120_000);

  it('understands a gzipped request and refuses other encodings', async () => {
    const w = await world();
    const probe = gzipSync(Buffer.from('0000'));
    const script = join(w.root, 'probe.mjs');
    writeFileSync(
      script,
      `const url = process.env.GIT_CONFIG_VALUE_0 + '/git-receive-pack';
const post = (encoding, body) => fetch(url, { method: 'POST', body, headers: { authorization: 'Bearer ' + process.env.AOC_INGEST_TOKEN, 'content-type': 'application/x-git-receive-pack-request', 'content-encoding': encoding } });
const a = await post('gzip', Buffer.from('${probe.toString('base64')}', 'base64'));
const b = await post('br', Buffer.from('0000'));
console.log(a.status, (await a.arrayBuffer()).byteLength, b.status);`,
    );
    const { out } = await w.run(`${JSON.stringify(process.execPath)} ${script}`);
    expect(out.stdout.trim()).toBe('200 0 415');
  }, 60_000);
});

const ZERO = '0'.repeat(40);

/** The gateway class on its own, with stand-ins for the supervisor and for the upstream push. */
async function unitWorld(opts: Partial<PushGatewayOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aoc-gateway-unit-'));
  closers.push(async () => rmSync(root, { recursive: true, force: true }));
  const work = join(root, 'work');
  initRepo(work);
  const sha = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  const pack = spawnSync('git', ['pack-objects', '--revs', '--stdout'], { cwd: work, input: `${sha}\n`, env: GIT_ENV }).stdout;
  const gateway = new PushGateway(
    {
      principal: (sessionId) => ({
        ok: true,
        vars: { sessionId, projectId: 'prj_demo', threadId: 'thr_1', ticketId: null },
        actor: { kind: 'agent', id: sessionId },
        profileName: 'git-feature',
        patterns: ['refs/heads/feature/**'],
      }),
      // The upstream accepts whatever is forwarded.
      forward: async (input) => ({
        exitCode: 0,
        stdout: input.command
          .filter((a) => /^[0-9a-f]{40}:refs\/heads\//.test(a))
          .map((a) => `*\t${a}\t[new branch]\n`)
          .join(''),
        stderr: '',
      }),
      record: () => undefined,
      env: () => process.env,
      now: () => Date.now(),
      log: silentLogger,
    },
    { root: join(root, 'git'), ...opts },
  );
  const repo = gateway.repoPath('prj_demo');
  mkdirSync(join(root, 'git'), { recursive: true });
  git(root, ['init', '-q', '--bare', '--template=', repo]);
  git(root, [`--git-dir=${repo}`, 'remote', 'add', 'origin', join(root, 'nowhere.git')]);
  return {
    gateway,
    repo,
    sha,
    pack,
    name: gateway.repoName('prj_demo'),
    /** A push of a new branch as git writes it: the capabilities ride on the first command. */
    command: (caps: string) => Buffer.concat([pkt(`${ZERO} ${sha} refs/heads/feature/x\0${caps}`), FLUSH]),
  };
}

const bodyOf = (...chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const b of chunks) c.enqueue(b);
      c.close();
    },
  });

describe('the gateway on its own', () => {
  it('stops receive-pack and moves no ref when the body fails in the middle of the pack', async () => {
    const u = await unitWorld();
    let step = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        step++;
        if (step === 1) c.enqueue(u.command('report-status'));
        else if (step === 2) c.enqueue(u.pack.subarray(0, 20)); // receive-pack now waits for the rest of the pack
        else c.error(new Error('connection reset'));
      },
    });
    await expect(u.gateway.receive('ses_1', u.name, body)).rejects.toThrow('connection reset');
    expect(git(u.repo, ['for-each-ref']).stdout).toBe('');
    // left alone it would wait for that pack for ever
    const running = spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).stdout;
    expect(running).not.toContain(`receive-pack --stateless-rpc ${u.repo}`);
  }, 30_000);

  it('hands receive-pack only the commands it checked, with only the capabilities the gateway speaks', async () => {
    const u = await unitWorld();
    const answer = await u.gateway.receive(
      'ses_1',
      u.name,
      bodyOf(u.command('report-status side-band-64k quiet atomic push-options agent=x'), u.pack),
    );
    // a plain report, not one wrapped in the side band the client asked for
    expect(answer.toString('latin1')).toContain('unpack ok');
    expect(answer.toString('latin1')).toContain('ok refs/heads/feature/x');
    expect(ref(u.repo, 'refs/heads/feature/x')).toBe(u.sha);
  }, 30_000);

  it('drops a request that stalls, so it cannot hold the project’s push lock', async () => {
    const u = await unitWorld({ idleTimeoutMs: 200 });
    const stalled = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(u.command('report-status'));
        c.enqueue(u.pack.subarray(0, 20));
      },
    });
    await expect(u.gateway.receive('ses_1', u.name, stalled)).rejects.toMatchObject({ status: 400, message: 'the push request stalled' });
    const next = await u.gateway.receive('ses_2', u.name, bodyOf(u.command('report-status'), u.pack));
    expect(next.toString('latin1')).toContain('ok refs/heads/feature/x');
  }, 30_000);

  it('stops reading a request that unpacks past the limit (a gzip bomb), however few bytes it took on the wire', async () => {
    const u = await unitWorld({ maxPackBytes: 1000 });
    const zeros = new Uint8Array(256 * 1024);
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(pulls++ === 0 ? u.command('report-status') : zeros);
      },
    });
    await expect(u.gateway.receive('ses_1', u.name, endless)).rejects.toMatchObject({ status: 413 });
    expect(pulls).toBeLessThan(40);
  }, 30_000);

  it('rebuilds the command section from what it parsed, shallow lines included, and rejects what it cannot read', () => {
    const id = 'a'.repeat(40);
    const wire = Buffer.concat([
      pkt(`shallow ${id}`),
      pkt(`${ZERO} ${id} refs/heads/feature/x\0report-status side-band-64k agent=x object-format=sha1`),
      pkt(`${id} ${id} refs/heads/feature/y\n`),
      FLUSH,
    ]);
    expect(commandSection(parseCommands(readPktLines(wire).lines)).toString('utf8')).toBe(
      Buffer.concat([
        pkt(`shallow ${id}`),
        pkt(`${ZERO} ${id} refs/heads/feature/x\0report-status object-format=sha1`),
        pkt(`${id} ${id} refs/heads/feature/y`),
        FLUSH,
      ]).toString('utf8'),
    );
    const lines = (...l: Buffer[]) => readPktLines(Buffer.concat([...l, FLUSH])).lines;
    expect(() => parseCommands(lines(pkt(`${ZERO} ${id} refs/heads/a`), pkt(`shallow ${id}`)))).toThrow();
    expect(() => parseCommands(lines(pkt(`${ZERO} ${id} refs/heads/a refs/heads/main`)))).toThrow();
    expect(() => parseCommands(lines(pkt(`shallow nothex`)))).toThrow();
  });

  it('refuses protected branches in any letter case, and does not let an id that is a glob widen a pattern', () => {
    const id = 'a'.repeat(40);
    const vars = { sessionId: 'ses_1', projectId: 'prj_1', threadId: 'thr_1', ticketId: 'tkt_*' };
    const update = (name: string) => ({ oldSha: ZERO, newSha: id, ref: `refs/heads/${name}` });
    for (const name of ['Main', 'MASTER', 'Release/1', 'production'])
      expect(refusalOf(update(name), ['refs/heads/**'], vars), name).toMatch(/protected branch/);
    expect(refusalOf(update('feature/x'), ['refs/heads/**'], vars)).toBeNull();
    expect(refusalOf(update('uat/tkt_9'), ['refs/heads/uat/{ticketId}'], vars)).toMatch(/not a branch/);
  });
});

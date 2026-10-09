import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitService, createLogger, initRepo } from '@aoc/kernel';
import { createHarness, type Harness } from './harness';

let h: Harness | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await h?.close();
  h = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = createGitService();

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/**
 * prj_demo's repository and a "model" that commits during a turn whenever `work()` was called since: the fake claude's
 * shell mode runs the script in the session's working directory, as the model's Bash tool would.
 */
function project() {
  const root = tempDir('aoc-heads-');
  const repo = join(root, 'repo');
  initRepo(repo);
  h!.ledger.repoPaths.set('prj_demo', repo);
  const flag = join(root, 'work');
  const script = join(root, 'work.sh');
  writeFileSync(
    script,
    `if [ -f '${flag}' ]; then rm '${flag}'; git -c user.name=agent -c user.email=agent@localhost commit --allow-empty -q -m work; fi\n`,
  );
  return {
    repo,
    head: () => git.head(repo)!,
    work: () => writeFileSync(flag, ''),
    prompt: (text: string) => `${text} [[fake:shell|script=${script}|out=${join(root, 'out.json')}]]`,
  };
}

const recorded = (id: string) => h!.events('session.head_recorded', id).map((e) => [e.meta.sha, e.meta.turn]);
const turnsEnded = (id: string) => h!.events('session.turn_ended', id).length;
async function turn(id: string, text: string): Promise<void> {
  const before = turnsEnded(id);
  await h!.sup.nudge(id, text, h!.ownerActor);
  await h!.waitFor(() => turnsEnded(id) === before + 1, `turn ${before + 1} of ${id} to end`);
}

describe("a build session's HEAD is recorded when its turn ends (G-25)", () => {
  it('records the HEAD the service reads, once per move, before the turn is closed', async () => {
    h = await createHarness();
    const p = project();
    const start = p.head();
    p.work();
    const id = await h.launch(p.prompt('Build the login page'));
    await h.waitLifecycle(id, 'idle');
    const first = p.head();
    expect(first).not.toBe(start);
    const [event] = h.events('session.head_recorded', id);
    expect(event).toMatchObject({
      actor: { kind: 'system', id: 'supervisor' },
      source: 'supervisor',
      scope: { sessionId: id, projectId: 'prj_demo' },
      meta: { sessionId: id, projectId: 'prj_demo', sha: first, turn: 1 },
    });
    expect(h.payload(event!)).toBeNull();
    expect(event!.seq).toBeLessThan(h.events('session.turn_ended', id)[0]!.seq);

    await turn(id, 'carry on'); // nothing was committed: the HEAD did not move
    expect(recorded(id)).toEqual([[first, 1]]);

    p.work();
    await turn(id, 'once more');
    expect(recorded(id)).toEqual([
      [first, 1],
      [p.head(), 3],
    ]);
    expect(p.head()).not.toBe(first);
  });

  it('records a session that never committed once, at the HEAD it started from', async () => {
    h = await createHarness();
    const p = project();
    const id = await h.launch(p.prompt('Read the code'));
    await h.waitLifecycle(id, 'idle');
    await turn(id, 'again');
    expect(recorded(id)).toEqual([[p.head(), 1]]);
  });

  it('records the HEAD the repository has at the end of the turn, wherever the session left it', async () => {
    h = await createHarness();
    const p = project();
    const start = p.head();
    p.work();
    const id = await h.launch(p.prompt('Build the login page'));
    await h.waitLifecycle(id, 'idle');
    git.run(p.repo, ['reset', '-q', '--hard', start]);
    await turn(id, 'again');
    expect(recorded(id).map(([sha]) => sha)).toEqual([expect.not.stringMatching(start), start]);
  });

  it('records nothing for a read-only session, a project without a repository, or a session working elsewhere', async () => {
    h = await createHarness();
    const p = project();
    p.work();
    const triage = await h.launch(p.prompt('Diagnose the ticket'), { processType: 'bug-triage' });
    await h.waitLifecycle(triage, 'idle');

    // Not the project's repository: a build in the project's own workspace directory, whose repository has moved on.
    const workspaces = h.t.config.supervisor.workspacesDir;
    mkdirSync(join(workspaces, 'prj_demo'), { recursive: true });
    p.work();
    const elsewhere = await h.launch(p.prompt('Build somewhere else'), { cwd: join(workspaces, 'prj_demo') });
    await h.waitLifecycle(elsewhere, 'idle');

    const none = await h.launch(p.prompt('Build without a repository'), { projectId: 'prj_other' });
    await h.waitLifecycle(none, 'idle');
    expect(h.events('session.head_recorded')).toEqual([]);
  });
});

describe('a repository that cannot be read does not fail the turn', () => {
  it('a directory that is no repository, or a service that throws, is logged and the turn ends as usual', async () => {
    const lines: string[] = [];
    h = await createHarness({ log: createLogger({ level: 'warn', sink: (l) => lines.push(l) }) });
    const notARepo = tempDir('aoc-notrepo-');
    h.ledger.repoPaths.set('prj_demo', notARepo);
    const plain = await h.launch('Build the login page');
    await h.waitLifecycle(plain, 'idle');
    expect(h.events('session.turn_ended', plain).map((e) => e.meta.outcome)).toEqual(['end_turn']);

    const p = project();
    h.t.rt.services.override('git', { ...createGitService(), head: () => { throw new Error('repository is locked'); } });
    const broken = await h.launch(p.prompt('Build the login page'));
    await h.waitLifecycle(broken, 'idle');
    expect(h.events('session.turn_ended', broken).map((e) => e.meta.outcome)).toEqual(['end_turn']);
    expect(h.events('session.head_recorded')).toEqual([]);
    expect(lines.filter((l) => l.includes('could not record the session HEAD'))).toHaveLength(1);
  });
});

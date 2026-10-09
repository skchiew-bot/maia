/**
 * (e) Failure semantics (§2): with aocd down, managed sessions fail loudly — PreToolUse is blocked (exit 2), other
 * events spool — while observed sessions never block and buffer locally. After a restart the spools replay once.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SpoolFlushResponse, SpoolItem } from '@aoc/contracts';
import { ClaudeSession, expectExit0, ObservedClaude } from './claude';
import { Harness, waitFor } from './harness';

let h: Harness;
beforeAll(async () => {
  h = await Harness.start();
});
afterAll(async () => {
  await h?.close();
});

const PLAN = { phases: [{ id: 'p1', name: 'Work', tasks: [{ id: 't1', title: 'Work', size: 's' }] }] };

function readSpool(dir: string): SpoolItem[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean))
    .map((l) => JSON.parse(l) as SpoolItem);
}

const toolUsed = (sessionId: string, toolUseId: string) =>
  h.events({ types: ['tool.used'], sessionId }).filter((e) => e.meta.toolUseId === toolUseId);

describe('(e) daemon down', () => {
  it('managed fails closed and spools, observed never blocks; after a restart both spools flush exactly once', async () => {
    const owner = await h.user('builder');
    const { projectId, repo } = await h.project(owner, 'Outage');
    const s = await h.launch(owner, { projectId });
    const claude = new ClaudeSession(h, s);
    await claude.start();
    await claude.aoc('declare_plan', PLAN);
    const observed = new ObservedClaude(h, repo, await h.observerToken());
    expectExit0(await observed.hook('SessionStart', { source: 'startup' }));
    const observedId = await waitFor(() => h.aoc.runtime.services.get('sessions').byClaudeSessionId(observed.claudeSessionId)?.sessionId, { what: 'observed session' });

    await h.stop();

    // Managed: the tool check fails closed — the tool never runs unaudited.
    const pre = await claude.hook('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: join(repo, 'README.md'), old_string: '#', new_string: '##' }, tool_use_id: 'toolu_blocked' });
    expect(pre.code).toBe(2);
    expect(pre.stderr).toMatch(/fail closed/);
    // Managed: everything else is spooled, with a loud systemMessage (exit 0).
    const read = { tool_name: 'Read', tool_input: { file_path: join(repo, 'README.md') }, tool_response: { type: 'text', file: { filePath: join(repo, 'README.md'), content: '# Outage\n' } } };
    const post = await claude.hook('PostToolUse', { ...read, tool_use_id: 'toolu_during_outage' });
    expect(post.code).toBe(0);
    expect(post.json?.systemMessage).toMatch(/spooled/);
    expect(readSpool(claude.spoolDir).map((i) => i.path)).toEqual(['/ingest/hook']);

    // Observed: never blocks, prints nothing, buffers the hook events and the turn's usage.
    const oPre = await observed.hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, tool_use_id: 'toolu_obs' });
    expect([oPre.code, oPre.stdout]).toEqual([0, '']);
    const oPost = await observed.hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, tool_response: { stdout: '', stderr: '' }, tool_use_id: 'toolu_obs' });
    expect([oPost.code, oPost.stdout]).toEqual([0, '']);
    const obsMsg = observed.transcript.assistant({ input: 30, output: 70, cacheRead: 9_000 }, [{ type: 'text', text: 'done' }], 'claude-sonnet-5-5');
    const oStop = await observed.hook('Stop', { stop_hook_active: false, last_assistant_message: 'done' });
    expect([oStop.code, oStop.stdout]).toEqual([0, '']);
    expect(readSpool(observed.spoolDir).map((i) => i.path).sort()).toEqual(['/ingest/hook', '/ingest/hook', '/ingest/hook', '/ingest/usage']);

    await h.restart();
    expect(toolUsed(s.sessionId, 'toolu_during_outage')).toHaveLength(0);

    // The next delivered managed event replays the spool (PreToolUse never does: it would delay the tool).
    const managedSpool = readSpool(claude.spoolDir);
    expectExit0(await claude.hook('PostToolUse', { ...read, tool_use_id: 'toolu_after_restart' }));
    await waitFor(() => readSpool(claude.spoolDir).length === 0, { what: 'managed spool flushed' });
    expect(toolUsed(s.sessionId, 'toolu_during_outage')).toHaveLength(1);
    expect(toolUsed(s.sessionId, 'toolu_after_restart')).toHaveLength(1);
    expect(h.events({ types: ['tool.used'], sessionId: s.sessionId }).find((e) => e.meta.toolUseId === 'toolu_during_outage')!.sourceTs).toBe(managedSpool[0]!.body && (managedSpool[0]!.body as { sentAt: string }).sentAt);

    // A replay whose reply was lost is sent again: the daemon recognises it and appends nothing.
    const again = await h.api<SpoolFlushResponse>('POST', '/ingest/spool', { headers: { authorization: `Bearer ${s.token}` }, body: { items: managedSpool } });
    expect(again).toEqual({ accepted: 0, duplicates: 1, rejected: 0 });
    expect(toolUsed(s.sessionId, 'toolu_during_outage')).toHaveLength(1);

    // Observed: the next delivered hook replays its spool — hook events and the usage read during the outage.
    expectExit0(await observed.hook('UserPromptSubmit', { prompt: 'carry on' }));
    await waitFor(() => readSpool(observed.spoolDir).length === 0, { what: 'observed spool flushed' });
    expect(toolUsed(observedId, 'toolu_obs')).toHaveLength(1);
    const usage = await waitFor(() => h.events({ types: ['usage.recorded'], sessionId: observedId }).length > 0 && h.events({ types: ['usage.recorded'], sessionId: observedId }), {
      timeout: 3_000,
      what: 'observed usage spooled during the outage',
    });
    expect(usage.map((e) => (h.store.readPayload(e) as { messageIds: string[] }).messageIds)).toEqual([[obsMsg]]);
    expect(usage[0]!.meta).toMatchObject({ model: 'claude-sonnet-5-5', inputTokens: 30, outputTokens: 70, cacheReadTokens: 9_000 });

    await claude.close();
    expect(h.store.verifyChain().ok).toBe(true);
  });

  it('two managed sessions on one host never lose each other’s spooled events (default spool dir)', async () => {
    const owner = await h.user('builder');
    const { projectId, repo } = await h.project(owner, 'Shared host');
    const a = new ClaudeSession(h, await h.launch(owner, { projectId }));
    const b = new ClaudeSession(h, await h.launch(owner, { projectId, cwd: repo }));
    // Neither session gets AOC_SPOOL_DIR: both fall back to the hook's default under the same HOME.
    const noSpoolDir = { env: { AOC_SPOOL_DIR: '' } };
    const read = (sessionCwd: string, id: string) => ({
      tool_name: 'Read',
      tool_input: { file_path: join(sessionCwd, 'README.md') },
      tool_response: { type: 'text' },
      tool_use_id: id,
    });

    await h.stop();
    expect((await a.hook('PostToolUse', read(a.s.cwd, 'toolu_a_outage'), noSpoolDir)).json?.systemMessage).toMatch(/spooled/);
    expect((await b.hook('PostToolUse', read(b.s.cwd, 'toolu_b_outage'), noSpoolDir)).json?.systemMessage).toMatch(/spooled/);
    await h.restart();

    // Session A's next event flushes whatever it can; B's own next event must still deliver B's buffered one.
    expectExit0(await a.hook('PostToolUse', read(a.s.cwd, 'toolu_a_after'), noSpoolDir));
    expectExit0(await b.hook('PostToolUse', read(b.s.cwd, 'toolu_b_after'), noSpoolDir));
    await waitFor(() => toolUsed(a.sessionId, 'toolu_a_outage').length === 1, { what: "A's spooled event" });
    await waitFor(() => toolUsed(b.sessionId, 'toolu_b_outage').length === 1, { timeout: 3_000, what: "B's spooled event" });
    expect(h.store.verifyChain().ok).toBe(true);
  });
});

// Keep the helper honest: a malformed spool line must not take the others down with it.
describe('(e) spool hygiene', () => {
  it('a corrupt spool line is skipped and the rest replays', async () => {
    const owner = await h.user('builder');
    const { projectId, repo } = await h.project(owner, 'Hygiene');
    const s = await h.launch(owner, { projectId });
    const claude = new ClaudeSession(h, s);
    await h.stop();
    const post = await claude.hook('PostToolUse', { tool_name: 'Read', tool_input: { file_path: join(repo, 'README.md') }, tool_response: {}, tool_use_id: 'toolu_good' });
    expect(post.json?.systemMessage).toMatch(/spooled/);
    const file = readdirSync(claude.spoolDir).find((f) => f.endsWith('.jsonl'))!;
    writeFileSync(join(claude.spoolDir, file), '{not json\n' + readFileSync(join(claude.spoolDir, file), 'utf8'));
    await h.restart();
    expectExit0(await claude.hook('Stop', { stop_hook_active: false, last_assistant_message: 'ok' }));
    await waitFor(() => toolUsed(s.sessionId, 'toolu_good').length === 1, { what: 'good line replayed' });
  });
});

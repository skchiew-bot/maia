/**
 * Read-only triage against the real CLI, through the intake portal: an end user's ticket spawns a triage session that
 * has only Read / Glob / Grep (plus the AOC tools), finds the root cause in the repository and ends with
 * report_diagnosis; the repository is untouched and the fix-plan gate opens.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InternalTicket, PublicTicket } from '@aoc/contracts';
import {
  REAL_CLI_ENABLED,
  dumpSession,
  eventsOf,
  git,
  payloadOf,
  startRealCli,
  streamsOf,
  toolUses,
  until,
  ended,
  waitUntil,
  type RealCli,
} from './support';

let r: RealCli;
beforeAll(async () => {
  if (REAL_CLI_ENABLED) r = await startRealCli({ config: { intake: { triageAgents: 1, triageProcessType: 'smoke-triage', buildProcessType: 'smoke' } } });
});
afterAll(async () => {
  await r?.close();
});

const FILES = {
  'README.md': '# Greeter\n\nPrints a greeting.\n',
  'package.json': JSON.stringify({ name: 'greeter', private: true, scripts: { test: 'node test.js' } }) + '\n',
  'src/greet.js': "exports.greet = function greet(name) {\n  return 'Hello, ' + nme + '!';\n};\n",
  'test.js': "const { greet } = require('./src/greet');\nif (greet('Ada') !== 'Hello, Ada!') throw new Error('greet is broken');\n",
};

describe.skipIf(!REAL_CLI_ENABLED)('real CLI: read-only triage', () => {
  it('intake ticket → triage with Read/Glob/Grep only → report_diagnosis → fix-plan gate; the repo is untouched', async () => {
    const requester = await r.h.user('requester', 'Nur');
    const { projectId, repo } = await r.h.project(r.dev, 'Greeter', FILES);
    const head = git(repo, 'rev-parse', 'HEAD');

    const form = new FormData();
    form.set('title', 'Greeting crashes');
    form.set('description', 'Calling greet("Ada") throws "ReferenceError: nme is not defined" instead of returning a greeting.');
    form.set('severity', 'high');
    form.set('projectId', projectId);
    const res = await fetch(`${r.h.url}/portal/api/intakes`, { method: 'POST', headers: requester.headers, body: form });
    expect(res.status).toBe(201);
    const ticket = (await res.json()) as PublicTicket;

    const internal = () => r.h.api<InternalTicket>('GET', `/api/tickets/${ticket.ticketId}`, { as: r.dev });
    const gated = await waitUntil(async () => {
      const t = await internal();
      return t.stage === 'fix_plan_gate' && t;
    }, 'the fix-plan gate (diagnosis reported)', 300_000);
    const triage = gated.diagnoses[0]!;
    const sessionId = triage.sessionId;
    try {
      // The turn ends by itself once the diagnosis is reported and the plan closed; nobody interrupts it.
      const finished = await until(r, sessionId, (d) => ended(d) || d.lifecycle === 'idle', 'the triage session to finish its turn');
      // Launched read-only: no credentials, only Read/Glob/Grep, deny list, dontAsk — and the CLI really exposes just those.
      const launched = eventsOf(r, sessionId, ['session.launch_requested'])[0]!;
      expect(launched.meta).toMatchObject({ processType: 'smoke-triage', readOnly: true, credentialProfile: null, ticketId: ticket.ticketId });
      const [turn] = streamsOf(r, sessionId);
      const init = turn!.find((o) => o.type === 'system' && o.subtype === 'init')!;
      expect((init.tools as string[]).filter((t) => !t.startsWith('mcp__')).sort()).toEqual(['Glob', 'Grep', 'Read']);
      expect(init.permissionMode).toBe('dontAsk');
      expect((init.mcp_servers as { name: string; status: string }[]).find((s) => s.name === 'aoc')?.status).toBe('connected');

      // It inspected the code and reported; nothing else (no write tool exists for it to call).
      const used = toolUses(streamsOf(r, sessionId)[0]!).map((c) => c.name);
      expect(used).toContain('mcp__aoc__report_diagnosis');
      expect(used.filter((n) => !n.startsWith('mcp__'))).not.toEqual([]);
      expect(used.filter((n) => !n.startsWith('mcp__') && !['Read', 'Glob', 'Grep'].includes(n))).toEqual([]);
      const reported = eventsOf(r, sessionId, ['ticket.diagnosis_reported'])[0]!;
      expect(reported).toMatchObject({ source: 'mcp', actor: { kind: 'agent', id: sessionId } });
      const diagnosis = payloadOf(r, reported)!;
      expect(JSON.stringify(diagnosis)).toMatch(/nme/);
      expect(triage.confidence).toBeGreaterThan(0.5);

      // eslint-disable-next-line no-console
      console.log(`TRIAGE-TASKS ${finished.lifecycle} ${JSON.stringify(eventsOf(r, sessionId, ['task.done']).map((e) => [e.meta.taskId, e.meta.evidenceKind, e.meta.flag]))}`);

      // The repository is exactly as it was.
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
      expect(git(repo, 'status', '--porcelain')).toBe('');
      expect(r.h.store.verifyChain().ok).toBe(true);
      // eslint-disable-next-line no-console
      console.log(`TRIAGE ${JSON.stringify({ outcomes: eventsOf(r, sessionId, ['session.turn_ended']).map((e) => e.meta.outcome), turns: eventsOf(r, sessionId, ['session.turn_started']).map((e) => e.meta.reason), tools: used })}`);
    } finally {
      await dumpSession(r, sessionId, 'triage');
    }
  });
});

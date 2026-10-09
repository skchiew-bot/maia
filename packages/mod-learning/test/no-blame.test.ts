import { describe, expect, it } from 'vitest';
import type { LessonDTO, LlmJsonRequest, OffenceDTO } from '@aoc/contracts';
import { LEARNING_TABLES } from '../src';
import {
  addSession,
  endSession,
  fileChange,
  learning,
  learningRuntime,
  report,
  toolFailure,
  usage,
} from './helpers';

/** Every key in a JSON value, recursively. */
function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysOf(x, out);
    }
  }
  return out;
}

describe('R11: never per-developer or per-user blame data', () => {
  it('no learning API response contains a user id, name, session id or per-person field — and projections store none', async () => {
    const t = await learningRuntime({ config: { learning: { retireAfterUnusedRuns: 1 } } });
    t.llm.on('learning.classify', (req: LlmJsonRequest) => {
      if (!req.prompt.includes('Cannot find module'))
        return { classId: null, newClass: null, confidence: 0.1 };
      const id = req.prompt.match(/id: (rcc_[0-9A-Z]+)/)?.[1];
      return id
        ? { classId: id, newClass: null, confidence: 0.9 }
        : {
            classId: null,
            newClass: { name: 'Module resolution config missing', dimension: 'tooling' },
            confidence: 0.9,
          };
    });
    t.llm.on('learning.distill', {
      skip: false,
      scopeType: 'process_type',
      scopeValue: 'bug-fix',
      rule: 'Check tsconfig paths first',
      fix: 'Add the path alias',
      rationale: 'Recurring in bug-fix runs',
    });
    const alice = t.user('builder', 'Alice Builder');
    const bob = t.user('approver', 'Bob Approver');
    const carol = t.user('requester', 'Carol Requester');
    const people = [
      alice.user.id,
      bob.user.id,
      carol.user.id,
      'Alice Builder',
      'Bob Approver',
      'Carol Requester',
    ];
    const sessions = ['ses_alice_1', 'ses_alice_2', 'ses_alice_3'];
    sessions.forEach((s, i) =>
      addSession(t, s, 'bug-fix', i === 2 ? 'claude-opus-5-5' : 'claude-haiku-5-5', {
        ownerId: alice.user.id,
        projectId: 'prj_shop',
      }),
    );
    const captured: unknown[] = [];
    const call = async <T>(
      method: string,
      path: string,
      headers: Record<string, string>,
      body?: unknown,
      expect = 200,
    ): Promise<T> => {
      const r = await t.json<T>(method, path, { headers, body, expect });
      captured.push(r);
      return r;
    };

    // occurrences from every path, with people as actors
    report(
      t,
      "Cannot find module '@shop/core'",
      { sessionId: 'ses_alice_1' },
      { kind: 'human', id: alice.user.id },
    );
    usage(t, 'ses_alice_1', 500, 5);
    toolFailure(
      t,
      'ses_alice_2',
      '{"stderr":"Cannot find module \'@shop/ui\'"}',
      '/work/repo/packages/shop/src/a.ts',
    );
    await t.request('POST', '/ingest/mcp/report_error', {
      headers: t.ingestHeaders('ses_alice_3'),
      body: {
        sessionId: 'ses_alice_3',
        input: { summary: "Cannot find module '@shop/api'", fix: 'Add the path alias' },
      },
    });
    t.rt.store.append({
      type: 'ticket.build_started',
      actor: { kind: 'human', id: alice.user.id },
      scope: { ticketId: 'tkt_9' },
      meta: { ticketId: 'tkt_9', sessionId: 'ses_alice_3', changeId: null },
      source: 'intake',
    });
    t.rt.store.append({
      type: 'ticket.uat_result',
      actor: { kind: 'human', id: carol.user.id },
      scope: { ticketId: 'tkt_9', userId: carol.user.id },
      meta: { ticketId: 'tkt_9', requesterId: carol.user.id, verdict: 'fail' },
      payload: { comment: 'Cart is empty after login' },
      source: 'intake',
    });
    await t.drain();
    await t.rt.runJob('learning.ai'); // AI clusters the module-resolution errors → offence detected

    // curation by people
    const [uatError] = (
      await call<{ errorId: string; source: string }[]>(
        'GET',
        '/api/learning/errors?unassigned=1',
        alice.headers,
      )
    ).filter((e) => e.source === 'uat');
    await call('POST', `/api/learning/errors/${uatError!.errorId}/root-cause`, alice.headers, {
      newClass: { name: 'Session handling unspecified', dimension: 'spec' },
    });
    const [off] = await call<OffenceDTO[]>('GET', '/api/learning/offences', alice.headers);
    await call('POST', `/api/learning/offences/${off!.offenceId}/transition`, alice.headers, {
      to: 'root_caused',
      note: 'Alias config missing',
      fix: 'Add the path alias',
    });
    await t.rt.runJob('learning.ai'); // distills a lesson proposal
    const manual = await call<LessonDTO>(
      'POST',
      '/api/learning/lessons',
      alice.headers,
      {
        scopeType: 'code_area',
        scopeValue: 'packages/shop',
        rule: 'Use the shop path aliases',
        fix: 'Import from @shop/*',
        rationale: 'Aliases recur',
      },
      201,
    );
    for (const l of await call<LessonDTO[]>('GET', '/api/learning/lessons', alice.headers))
      await t.decisions!.resolve(l.decisionId, { optionId: 'bind' }, bob.user);
    await t.drain();
    learning(t).recordLessonsApplied(
      learning(t)
        .lessonsForScope({ processType: 'bug-fix', codeAreas: ['packages/shop'] })
        .map((l) => l.lessonId),
      'ses_alice_1',
      { kind: 'human', id: alice.user.id },
    );
    fileChange(t, 'ses_alice_1', '/work/repo/packages/shop/src/a.ts');
    endSession(t, 'ses_alice_1');
    await call('POST', `/api/learning/offences/${off!.offenceId}/transition`, alice.headers, {
      to: 'fix_applied',
      note: 'Aliases added',
    });
    await call('POST', `/api/learning/lessons/${manual.lessonId}/retire`, alice.headers);
    await t.rt.runJob('learning.retire-lessons');

    for (const path of [
      '/api/learning/errors',
      '/api/learning/classes',
      '/api/learning/offences',
      '/api/learning/trends?weeks=4',
      '/api/learning/model-dimension',
      '/api/learning/lessons',
    ]) {
      await call('GET', path, bob.headers);
    }
    // sanity: the scan covers real data from every area
    const text = JSON.stringify(captured);
    expect(text).toContain('Cart is empty after login');
    expect(text).toContain('Check tsconfig paths first');
    expect(text).toContain('"state":"fix_applied"');

    for (const needle of [...people, ...sessions, 'usr_']) expect(text).not.toContain(needle);
    const keys = keysOf(captured);
    for (const k of [
      'actor',
      'actorId',
      'userId',
      'user',
      'ownerId',
      'ownerName',
      'owner',
      'requesterId',
      'resolvedBy',
      'approverId',
      'proposedBy',
      'by',
      'byName',
      'sessionId',
      'byUser',
      'byOwner',
      'byActor',
      'byDeveloper',
    ]) {
      expect(keys.has(k), `response key ${k}`).toBe(false);
    }
    // projections never store the person either (session ids only, for model / process-type analysis)
    for (const table of LEARNING_TABLES) {
      const rows = JSON.stringify(t.rt.store.db.prepare(`SELECT * FROM ${table}`).all());
      for (const needle of people) expect(rows, table).not.toContain(needle);
    }
    await t.close();
  });
});

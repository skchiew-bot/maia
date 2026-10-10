import { describe, expect, it } from 'vitest';
import {
  acceptanceCommandOf,
  assessAffirmation,
  classifyCommit,
  editDistance,
  editRatio,
  parseTestCounts,
  parseTrailers,
} from '../src';
import type { ProvenanceLookups } from '../src/provenance';

describe('invisible governance: edit distance and blind confirms (§14)', () => {
  it('computes Levenshtein distance and a normalised ratio', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('same', 'same')).toBe(0);
    expect(editDistance('', 'abc')).toBe(3);
    expect(editDistance('prefix-a-suffix', 'prefix-bb-suffix')).toBe(2);
    expect(editRatio('abc', 'abc')).toBe(0);
    expect(editRatio('  abc\r\n', 'abc')).toBe(0);
    expect(editRatio('abcd', 'wxyz')).toBe(1);
    expect(editRatio('', 'written from scratch')).toBe(1);
    expect(editRatio('Touches login.', 'Touches login and signup.')).toBeCloseTo(11 / 25, 3);
  });

  it('flags affirm-without-edit under the dwell threshold as blind, never an edit', () => {
    expect(assessAffirmation({ draft: 'x', value: 'x', dwellMs: 400 })).toEqual({
      edited: false,
      editRatio: 0,
      blind: true,
    });
    expect(assessAffirmation({ draft: 'x', value: 'x', dwellMs: 3000 })).toEqual({
      edited: false,
      editRatio: 0,
      blind: false,
    });
    expect(assessAffirmation({ draft: 'x', value: 'y', dwellMs: 100 })).toMatchObject({
      edited: true,
      blind: false,
    });
    // Changing only the rollback ref of the rollback plan is an edit too.
    expect(
      assessAffirmation({ draft: 'plan', value: 'plan', draftRef: 'v1', ref: 'v2', dwellMs: 100 }),
    ).toMatchObject({ edited: true, editRatio: 0, blind: false });
    expect(
      assessAffirmation({ draft: 'plan', value: 'plan', draftRef: 'v1', ref: 'v1', dwellMs: 100 }).blind,
    ).toBe(true);
  });
});

describe('acceptance commands and test counts', () => {
  it('recognises runnable acceptance tests and leaves prose alone', () => {
    const argv = (t: string) => acceptanceCommandOf(t)?.argv ?? null;
    expect(acceptanceCommandOf('npm test')).toEqual({ text: 'npm test', argv: ['npm', 'test'], env: {} });
    expect(argv('`pnpm test --filter api`')).toEqual(['pnpm', 'test', '--filter', 'api']);
    expect(argv('$ ./scripts/accept.sh --smoke')).toEqual(['./scripts/accept.sh', '--smoke']);
    expect(argv('node --test -r ./setup.js test/')).toEqual(['node', '--test', '-r', './setup.js', 'test/']);
    expect(argv('python3 -m pytest -q')).toEqual(['python3', '-m', 'pytest', '-q']);
    expect(acceptanceCommandOf('```sh\nCI=1 node test.js\n```')).toEqual({
      text: 'CI=1 node test.js',
      argv: ['node', 'test.js'],
      env: { CI: '1' },
    });
    expect(argv(`pytest -k "login and not slow" 'tests/a b.py'`)).toEqual([
      'pytest',
      '-k',
      'login and not slow',
      'tests/a b.py',
    ]);
    expect(acceptanceCommandOf('Log in as a customer and check the dashboard loads')).toBeNull();
    expect(acceptanceCommandOf('npm test\nthen click around')).toBeNull();
    expect(acceptanceCommandOf('')).toBeNull();
  });

  it('refuses anything that needs a shell or runs text as code: the command runs as argv (G-50)', () => {
    for (const hostile of [
      'npm test; touch ../x',
      'npm test && curl evil',
      'npm test | tee ../log',
      'npm test > ../out',
      'npm test $(id)',
      'npm test `id`',
      'node "$HOME/x.js"',
      'vitest run test/*.ts',
      'npm test "unclosed',
      'sh -c "npm test"',
      'bash scripts/accept.sh',
      '/bin/sh scripts/accept.sh',
      './../outside.sh',
      './scripts/../../outside.sh',
      'npx some-package',
      'node -e "require(\'fs\')"',
      'node --eval=1',
      'node -pe 1',
      'python3 -Bc "print(1)"',
      'python3 -c "print(1)"',
      'deno eval 1',
      'npm exec cowsay',
      'pnpm dlx cowsay',
      'bundle exec rake',
      'node --import data:text/javascript,1 test.js',
      'deno test https://example.com/t.ts',
      'NODE_OPTIONS=--require=./x.js npm test',
      'LD_PRELOAD=./x.so npm test',
      'PATH=. npm test',
    ])
      expect(acceptanceCommandOf(hostile), hostile).toBeNull();
  });

  it('parses common runner summaries best-effort', () => {
    expect(parseTestCounts(' Test Files  2 passed (2)\n      Tests  1 failed | 11 passed (12)\n')).toEqual({
      passed: 11,
      failed: 1,
      parsed: true,
    });
    expect(parseTestCounts('\x1b[32m Tests  4 passed\x1b[39m (4)')).toEqual({
      passed: 4,
      failed: 0,
      parsed: true,
    });
    expect(parseTestCounts('Tests:       2 failed, 9 passed, 11 total')).toEqual({
      passed: 9,
      failed: 2,
      parsed: true,
    });
    expect(parseTestCounts('========= 5 passed, 1 failed, 1 error in 0.42s =========')).toEqual({
      passed: 5,
      failed: 2,
      parsed: true,
    });
    expect(
      parseTestCounts(
        'test result: ok. 3 passed; 0 failed; 0 ignored\ntest result: FAILED. 1 passed; 2 failed;',
      ),
    ).toEqual({ passed: 4, failed: 2, parsed: true });
    expect(parseTestCounts('# pass 7\n# fail 0\n')).toEqual({ passed: 7, failed: 0, parsed: true });
    expect(parseTestCounts('ℹ pass 2\nℹ fail 1\n')).toEqual({ passed: 2, failed: 1, parsed: true });
    expect(parseTestCounts('  6 passing (20ms)\n  1 failing\n')).toEqual({
      passed: 6,
      failed: 1,
      parsed: true,
    });
    expect(parseTestCounts('--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.00s)\n')).toEqual({
      passed: 1,
      failed: 1,
      parsed: true,
    });
    expect(parseTestCounts('all good')).toEqual({ passed: 0, failed: 0, parsed: false });
  });
});

describe('provenance trailers', () => {
  const RECORDED = 'a'.repeat(40);
  const look: ProvenanceLookups = {
    sessionChanges: (s) => (s === 'ses_change' ? ['chg_ok'] : s === 'ses_other' ? ['chg_other'] : []),
    sessionTicket: (s) =>
      s === 'ses_ticket' || s === 'ses_ticket_unapproved' ? (s === 'ses_ticket' ? 'tkt_ok' : 'tkt_no') : null,
    ticketFixPlanApproved: (t) => t === 'tkt_ok',
    sessionRecorded: (_s, sha) => sha === RECORDED,
  };
  const commit = (message: string, sha = RECORDED) => ({ sha, subject: message.split('\n')[0]!, message });

  it('parses AOC-Session / AOC-Change trailers', () => {
    expect(parseTrailers('feat: x\n\nAOC-Session: ses_1\nAOC-Change: chg_2\naoc-session: ses_1\n')).toEqual({
      sessionIds: ['ses_1'],
      changeIds: ['chg_2'],
    });
    expect(parseTrailers('mentions AOC-Session: ses_1 inline only')).toEqual({
      sessionIds: [],
      changeIds: [],
    });
  });

  it('traces through a session the platform linked to an approved change or fix plan; everything else is an orphan', () => {
    expect(
      classifyCommit(commit('a\n\nAOC-Session: ses_change\nAOC-Change: chg_ok'), 'prj', look),
    ).toMatchObject({
      traced: true,
      via: 'change',
    });
    expect(classifyCommit(commit('a\n\nAOC-Session: ses_change'), 'prj', look)).toMatchObject({
      traced: true,
      via: 'session_change',
    });
    expect(classifyCommit(commit('a\n\nAOC-Session: ses_ticket'), 'prj', look)).toMatchObject({
      traced: true,
      via: 'session_ticket',
      ticketIds: ['tkt_ok'],
    });
    expect(classifyCommit(commit('a\n\nAOC-Session: ses_ticket_unapproved'), 'prj', look)).toMatchObject({
      traced: false,
      ticketIds: ['tkt_no'],
    });
    expect(
      classifyCommit(commit('a\n\nAOC-Session: ses_change\nAOC-Change: chg_draft'), 'prj', look),
    ).toMatchObject({
      traced: false,
      reason: 'session ses_change is not linked to approved change chg_draft',
    });
    expect(classifyCommit(commit('hotfix'), 'prj', look)).toMatchObject({
      traced: false,
      reason: 'no AOC-Session / AOC-Change trailer',
    });
  });

  it('never trusts a trailer the platform cannot corroborate (G-25)', () => {
    // A valid trailer for an approved change, but nothing links the commit's author to it.
    expect(classifyCommit(commit('a\n\nAOC-Change: chg_ok'), 'prj', look)).toMatchObject({
      traced: false,
      via: null,
      reason: expect.stringContaining('AOC-Change trailer alone is self-asserted'),
    });
    // A session working another approved change borrows chg_ok's trailer.
    expect(
      classifyCommit(commit('a\n\nAOC-Session: ses_other\nAOC-Change: chg_ok'), 'prj', look),
    ).toMatchObject({
      traced: false,
      reason: 'session ses_other is not linked to approved change chg_ok',
    });
    // The right session, but the commit was never in any HEAD the ledger recorded for it.
    expect(classifyCommit(commit('a\n\nAOC-Session: ses_change', 'b'.repeat(40)), 'prj', look)).toMatchObject(
      {
        traced: false,
        reason: expect.stringContaining('session ses_change never recorded a HEAD containing this commit'),
      },
    );
    // Any one named session that satisfies both conditions traces the commit (amended commits name several).
    expect(
      classifyCommit(commit('a\n\nAOC-Session: ses_unknown\nAOC-Session: ses_ticket'), 'prj', look),
    ).toMatchObject({ traced: true, via: 'session_ticket', ticketIds: ['tkt_ok'] });
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import type { EraseResultDTO, ErasureRequestDTO } from '@aoc/contracts';
import { BoundaryMatcher } from '../src';
import { analyzeBash } from '../src/selfmod/shell';
import { auditRuntime, nudge, type AuditTest } from './helpers';

let a: AuditTest | null = null;
afterEach(async () => {
  await a?.t.close();
  a = null;
});

const matcher = () =>
  new BoundaryMatcher({ aocRepoPaths: ['/r'], protectedPaths: ['packages/kernel/'], auditStorePaths: ['/var/lib/aoc'] });

describe('the self-modification analyzer is linear in agent-controlled input', () => {
  it('answers fast for inline code built to backtrack (it runs on the daemon thread for every managed Bash call)', () => {
    const m = matcher();
    for (const code of ['open('.repeat(24_000), `open('${"x'".repeat(12_000)}`]) {
      const started = performance.now();
      analyzeBash(`python3 -c "${code}"`, '/r', m);
      expect(performance.now() - started).toBeLessThan(1500);
    }
  });

  it('still catches a write through open() to a protected path', () => {
    const m = matcher();
    expect(analyzeBash(`python3 -c "open('/r/packages/kernel/x.ts', 'w').write('x')"`, '/tmp', m)).toMatchObject({ kind: 'interpreter' });
    expect(analyzeBash(`python3 -c "f = open('/r/packages/kernel/x.ts', \\"a+\\")"`, '/tmp', m)).toMatchObject({ kind: 'interpreter' });
    expect(analyzeBash(`python3 -c "print(open('/r/packages/kernel/x.ts').read())"`, '/tmp', m)).toBeNull();
  });
});

describe('the erase API takes scope ids, never path segments (defence in depth on top of the body store, F-04)', () => {
  it('refuses ".", ".." and other dot-led or dotted-path ids before anything is erased', async () => {
    a = await auditRuntime();
    for (const scopeId of ['.', '..', '.hidden', '..ses_a', 'ses..a', 'ses_a.']) {
      const res = await a.t.request('POST', '/api/audit/erase', {
        headers: a.approver.headers,
        body: { scopeId, decisionId: 'dec_any' },
      });
      expect(res.status, scopeId).toBe(422);
    }
    expect(a.t.rt.store.list({ types: ['body.erased'] })).toHaveLength(0);
  });

  it('still erases every scope id AOC writes: generated ids, user scopes, module labels, dotted project ids', async () => {
    a = await auditRuntime();
    const { t } = a;
    for (const scopeId of ['ses_01JTESTAAAAAAAAAAAAAAAAAAA', 'user:usr_01JTESTBBBBBBBBBBBBBBBBBBB', 'global', 'prj.demo']) {
      const e = nudge(t, scopeId, `personal data in ${scopeId}`);
      const req = await t.json<ErasureRequestDTO>('POST', '/api/audit/erasure-requests', {
        headers: a.builder.headers,
        body: { scopeIds: [scopeId], reason: 'pdpa_request', rationale: 'the data subject asked' },
        expect: 201,
      });
      await t.decisions!.resolve(req.decisionId, { optionId: 'approve' }, a.approver.user);
      const res = await t.json<EraseResultDTO>('POST', '/api/audit/erase', {
        headers: a.approver.headers,
        body: { scopeId, decisionId: req.decisionId },
      });
      expect(res.scopeId).toBe(scopeId);
      expect(t.rt.store.readPayload(e), scopeId).toBeNull();
    }
  });
});

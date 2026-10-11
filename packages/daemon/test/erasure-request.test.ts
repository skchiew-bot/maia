import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DecisionCardView, EraseResultDTO, ErasureRequestDTO } from '@aoc/contracts';
import { createAuditModule } from '@aoc/mod-audit';
import { createDecisionsModule } from '@aoc/mod-decisions';
import { bootTestServer, removeTempDirs, tempDir, type TestServer } from './helpers';

const servers: TestServer[] = [];
afterEach(async () => {
  for (const t of servers.splice(0)) await t.close();
  removeTempDirs();
});

describe('erasure under an approved request, on the real decisions module (O-28, G-47)', () => {
  it('a Builder asks, cannot approve their own request, the Approver approves and erases; the request text has its own scope', async () => {
    const t = await bootTestServer({
      modules: [createDecisionsModule(), createAuditModule()],
      config: { audit: { anchorProvider: 'none', anchorRepoPath: join(tempDir(), 'anchor') } },
    });
    servers.push(t);
    const builder = t.user('builder');
    const approver = t.user('approver');
    const call = async <T>(who: { headers: Record<string, string> }, method: string, path: string, body?: unknown) => {
      const res = await t.request(path, {
        method,
        headers: { ...who.headers, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, json: (await res.json()) as T };
    };
    const store = t.aoc.runtime.store;
    const leaked = store.append({
      type: 'session.nudged',
      actor: { kind: 'human', id: 'usr_test' },
      scope: { sessionId: 'ses_leak' },
      meta: { sessionId: 'ses_leak' },
      payload: { text: 'token sk-live-123' },
      source: 'api',
    });

    const req = await call<ErasureRequestDTO>(builder, 'POST', '/api/audit/erasure-requests', {
      scopeIds: ['ses_leak'],
      reason: 'secret_leak',
      rationale: 'A live key was pasted into a nudge',
    });
    expect(req.status).toBe(201);
    const { decisionId, requestId } = req.json;
    const card = await call<DecisionCardView>(builder, 'GET', `/api/decisions/${decisionId}`);
    expect(card.json).toMatchObject({ kind: 'erasure_request', requiredRole: 'approver', viewer: { canResolve: false } });
    expect((await call(builder, 'POST', `/api/decisions/${decisionId}/resolve`, { optionId: 'approve' })).status).toBe(403);
    expect((await call(approver, 'POST', '/api/audit/erase', { scopeId: 'ses_leak', decisionId })).status).toBe(409);

    expect((await call(approver, 'POST', `/api/decisions/${decisionId}/resolve`, { optionId: 'approve' })).status).toBe(200);
    const erased = await call<EraseResultDTO>(approver, 'POST', '/api/audit/erase', { scopeId: 'ses_leak', decisionId });
    expect(erased).toMatchObject({ status: 200, json: { reason: 'secret_leak', bodiesErased: 1, decisionId } });
    expect(store.readPayload(leaked)).toBeNull();

    // The rationale and the card that quotes it live in the request's own scope.
    expect(store.list({ types: ['erasure.requested'] })[0]!.bodyScope).toBe(requestId);
    expect(store.list({ types: ['decision.requested'], decisionId })[0]!.bodyScope).toBe(requestId);
  });
});

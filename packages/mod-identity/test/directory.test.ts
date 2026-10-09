import { describe, expect, it } from 'vitest';
import type { DirectoryDto } from '@aoc/contracts';
import { setupIdentity } from './helpers/setup';

describe('operator directory (GET /api/directory)', () => {
  it('names approvers and builders for every operator, never requesters or emails', async () => {
    const { t, h } = await setupIdentity();
    const ceo = h.user('approver', 'Chiew Sin Kwang', { email: 'ceo@example.test' });
    const priya = h.user('builder', 'Priya Nair', { complianceLead: true });
    const requester = h.user('requester', 'Daniel Lim');

    for (const viewer of [ceo, priya]) {
      const body = await t.json<DirectoryDto>('GET', '/api/directory', { headers: viewer.headers });
      expect(body.people).toEqual([
        { id: ceo.user.id, name: 'Chiew Sin Kwang', role: 'approver', active: true, complianceLead: false },
        { id: priya.user.id, name: 'Priya Nair', role: 'builder', active: true, complianceLead: true },
      ]);
      expect(JSON.stringify(body)).not.toContain('example.test');
    }

    expect((await t.request('GET', '/api/directory')).status).toBe(401);
    expect((await t.request('GET', '/api/directory', { headers: requester.headers })).status).toBe(403);
    await t.close();
  });
});

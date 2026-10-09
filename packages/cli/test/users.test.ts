import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aoc, loggedInHome, TOKEN } from './helpers/cli';
import { startFakeDaemon, type FakeDaemon } from './helpers/fake-daemon';
import { user } from './helpers/fixtures';

let d: FakeDaemon;
let home: string;
beforeEach(async () => {
  d = await startFakeDaemon();
  home = loggedInHome(d.url);
});
afterEach(() => d.stop());

describe('aoc users', () => {
  it('list renders a table', async () => {
    d.on('GET', '/api/users', {
      json: [user(), user({ id: 'usr_2', name: 'Chiew', role: 'approver', flags: { complianceLead: true } })],
    });
    const r = await aoc(['users', 'list'], { homeDir: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/usr_2\s+Chiew\s+approver\s+compliance lead\s+yes/);
  });

  it('add POSTs name, role and the compliance-lead flag', async () => {
    d.on('POST', '/api/users', { status: 201, json: user({ id: 'usr_3', name: 'Dana', role: 'requester' }) });
    const r = await aoc(
      [
        'users',
        'add',
        '--name',
        'Dana',
        '--role',
        'requester',
        '--email',
        'dana@example.com',
        '--compliance-lead',
      ],
      { homeDir: home },
    );
    expect(r.code).toBe(0);
    expect(d.calls('POST', '/api/users')[0]!.body).toEqual({
      name: 'Dana',
      role: 'requester',
      email: 'dana@example.com',
      complianceLead: true,
    });
    expect(r.stdout).toContain('Created Dana (usr_3) as requester, compliance lead.');
  });

  it('add rejects an unknown role or a missing name (exit 2)', async () => {
    expect((await aoc(['users', 'add', '--name', 'X', '--role', 'admin'], { homeDir: home })).code).toBe(2);
    expect((await aoc(['users', 'add', '--role', 'builder'], { homeDir: home })).code).toBe(2);
    expect(d.requests).toHaveLength(0);
  });
});

describe('aoc token create', () => {
  it('issues a token for --user and prints it once, alone on stdout', async () => {
    d.on('POST', '/api/users/usr_2/tokens', {
      status: 201,
      json: { token: 'aoc_u_NEW', tokenId: 'tok_9', label: 'ci' },
    });
    const r = await aoc(['token', 'create', '--user', 'usr_2', '--label', 'ci'], { homeDir: home });
    expect(r.code).toBe(0);
    expect(d.calls('POST', '/api/users/usr_2/tokens')[0]!.body).toEqual({ label: 'ci' });
    expect(r.stdout).toBe('aoc_u_NEW\n');
    expect(r.stderr).toContain('shown once');
    expect(r.stderr).not.toContain('aoc_u_NEW');
  });

  it('defaults to the caller (resolved through GET /api/auth/me)', async () => {
    d.on('GET', '/api/auth/me', { json: { user: user({ id: 'usr_me' }) } });
    d.on('POST', '/api/users/usr_me/tokens', { json: { token: 'aoc_u_MINE' } });
    const r = await aoc(['token', 'create'], { homeDir: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('aoc_u_MINE\n');
    expect(d.calls('POST', '/api/users/usr_me/tokens')[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('fails if the daemon returns no token', async () => {
    d.on('POST', '/api/users/usr_2/tokens', { json: { tokenId: 'tok_9' } });
    expect((await aoc(['token', 'create', '--user', 'usr_2'], { homeDir: home })).code).toBe(1);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aoc, loggedInHome, TOKEN } from './helpers/cli';
import { startFakeDaemon, type FakeDaemon } from './helpers/fake-daemon';
import { card } from './helpers/fixtures';

let d: FakeDaemon;
let home: string;
beforeEach(async () => {
  d = await startFakeDaemon();
  home = loggedInHome(d.url);
});
afterEach(() => d.stop());

const newer = card({ id: 'dec_new', title: 'Newer', createdAt: '2026-10-09T09:55:00.000Z' });
const goLive = card({
  id: 'dec_golive',
  kind: 'go_live',
  test: null,
  title: 'Promote to main',
  requiredRole: 'approver',
  requiresPasskey: true,
  options: [
    { id: 'approve', label: 'Approve' },
    { id: 'reject', label: 'Reject' },
  ],
  recommendation: null,
  createdAt: '2026-10-08T10:00:00.000Z',
});

describe('aoc decisions', () => {
  it('lists open decisions oldest first, with age, options (*recommended) and who is needed', async () => {
    d.on('GET', '/api/decisions', {
      json: [newer, card(), goLive, card({ id: 'dec_done', status: 'resolved' })],
    });
    const r = await aoc(['decisions'], { homeDir: home });
    expect(r.code).toBe(0);
    expect(d.calls('GET', '/api/decisions')[0]!.query).toEqual({ status: 'open' });
    const rows = r.stdout.split('\n').slice(1, 4);
    expect(rows[0]).toMatch(
      /^dec_golive\s+24h\s+go_live\s+Promote to main\s+approve \| reject\s+approver \+ passkey\s+ses_A$/,
    );
    expect(rows[1]).toMatch(
      /^dec_1\s+30m\s+agent_decision\/irreversible\s+Pick a schema\s+a\* \| b\s+builder\s+ses_A$/,
    );
    expect(rows[2]).toMatch(/^dec_new\s+5m\s+/);
    expect(r.stdout).not.toContain('dec_done');
    expect(r.stdout).toContain('aoc decide <id> --option <optionId>');
  });

  it('--all asks for every status and shows a STATUS column', async () => {
    d.on('GET', '/api/decisions', {
      json: [
        card({
          id: 'dec_done',
          status: 'resolved',
          resolution: {
            optionId: 'b',
            resolvedBy: 'usr_1',
            resolvedAt: '',
            method: 'button',
            passkeyVerified: false,
            selfApproved: false,
            comment: null,
          },
        }),
      ],
    });
    const r = await aoc(['decisions', '--all'], { homeDir: home });
    expect(d.calls('GET', '/api/decisions')[0]!.query).toEqual({});
    expect(r.stdout).toMatch(/^ID\s+AGE\s+STATUS\s+KIND/);
    expect(r.stdout).toMatch(/dec_done\s+30m\s+resolved: b\s+/);
  });

  it('says nothing is waiting when the inbox is empty', async () => {
    d.on('GET', '/api/decisions', { json: { decisions: [] } });
    expect((await aoc(['decisions'], { homeDir: home })).stdout).toContain('No open decisions');
  });
});

describe('aoc decide', () => {
  it('looks the card up in the open inbox, then resolves with POST /api/decisions/:id/resolve', async () => {
    d.on('GET', '/api/decisions', { json: [newer, card()] });
    d.on('POST', '/api/decisions/dec_1/resolve', { json: card({ status: 'resolved' }) });
    const r = await aoc(['decide', 'dec_1', '--option', 'b', '--comment', 'keeps it reversible'], {
      homeDir: home,
    });
    expect(r.code).toBe(0);
    expect(d.calls('GET', '/api/decisions')[0]!.query).toEqual({ status: 'open' });
    const [post] = d.calls('POST', '/api/decisions/dec_1/resolve');
    expect(post!.body).toEqual({ optionId: 'b', comment: 'keeps it reversible' });
    expect(post!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(r.stdout).toContain('Resolved dec_1 → b (Option B).');
  });

  it('a passkey decision is never resolved from the CLI: prints the console link and exits 3', async () => {
    d.on('GET', '/api/decisions', { json: { decisions: [card(), goLive] } });
    d.on('POST', '/api/decisions/dec_golive/resolve', { json: {} });
    const r = await aoc(['decide', 'dec_golive', '--option', 'approve'], { homeDir: home });
    expect(r.code).toBe(3);
    expect(r.stderr.trim()).toBe(
      `Requires a passkey — approve in the console: ${d.url}/decisions?id=dec_golive`,
    );
    expect(d.calls('POST', '/api/decisions/dec_golive/resolve')).toHaveLength(0);
  });

  it('passkey kinds (rollback, go-live, break-glass) are gated by the shared policy even if the flag is missing', async () => {
    d.on('GET', '/api/decisions', {
      json: [card({ id: 'dec_rb', kind: 'rollback', requiresPasskey: false })],
    });
    const r = await aoc(['decide', 'dec_rb', '--option', 'a'], { homeDir: home });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('Requires a passkey');
    expect(d.calls('POST', '/api/decisions/dec_rb/resolve')).toHaveLength(0);
  });

  it('when the card is not in the inbox, the resolve answer decides (passkey error → exit 3)', async () => {
    d.on('POST', '/api/decisions/dec_x/resolve', {
      status: 403,
      json: { error: { code: 'passkey_required', message: 'Passkey assertion required' } },
    });
    const r = await aoc(['decide', 'dec_x', '--option', 'approve'], { homeDir: home });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain(`Requires a passkey — approve in the console: ${d.url}/decisions?id=dec_x`);
    expect(d.calls('GET', '/api/decisions')).toHaveLength(1);
  });

  it('an already-resolved decision is reported by the daemon (exit 1)', async () => {
    d.on('GET', '/api/decisions', { json: [] });
    d.on('POST', '/api/decisions/dec_1/resolve', {
      status: 409,
      json: { error: { code: 'conflict', message: 'Decision dec_1 is already resolved' } },
    });
    const r = await aoc(['decide', 'dec_1', '--option', 'a'], { homeDir: home });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('error: Decision dec_1 is already resolved');
  });

  it('rejects an option the card does not offer (exit 2) without resolving', async () => {
    d.on('GET', '/api/decisions', { json: [card()] });
    const r = await aoc(['decide', 'dec_1', '--option', 'zzz'], { homeDir: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('hint: options: a, b');
    expect(d.calls('POST', '/api/decisions/dec_1/resolve')).toHaveLength(0);
  });

  it('refuses when the viewer may not resolve it (exit 3, e.g. separation of duties)', async () => {
    d.on('GET', '/api/decisions', {
      json: [card({ viewer: { canResolve: false, reason: 'you requested it (separation of duties)' } })],
    });
    const r = await aoc(['decide', 'dec_1', '--option', 'a'], { homeDir: home });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('separation of duties');
    expect(d.calls('POST', '/api/decisions/dec_1/resolve')).toHaveLength(0);
  });

  it('--option is required (exit 2)', async () => {
    expect((await aoc(['decide', 'dec_1'], { homeDir: home })).code).toBe(2);
  });
});

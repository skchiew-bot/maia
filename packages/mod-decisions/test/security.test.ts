import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decisionInput, harness, human, type Harness } from './helpers';

let h: Harness | undefined;
const servers: Server[] = [];
afterEach(async () => {
  await h?.t.close();
  h = undefined;
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

async function listen(handler: (path: string, res: import('node:http').ServerResponse) => void): Promise<string> {
  const s = createServer((req, res) => handler(req.url ?? '/', res));
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

describe('opt-in decision webhook', () => {
  it('does not follow redirects (the receiver cannot bounce aocd onto internal endpoints)', async () => {
    const internalHits: string[] = [];
    const internal = await listen((path, res) => {
      internalHits.push(path);
      res.end('{}');
    });
    const receiverHits: string[] = [];
    const receiver = await listen((path, res) => {
      receiverHits.push(path);
      res.writeHead(302, { location: `${internal}/admin/secret` }).end();
    });
    const { t, engine, builderA } = (h = await harness({ config: { decisions: { webhookUrl: `${receiver}/hook` } } }));
    engine.request(decisionInput({ kind: 'fix_plan', requesterId: builderA.user.id }), human(builderA));
    await t.drain();
    await vi.waitFor(() => expect(receiverHits).toEqual(['/hook']));
    await new Promise((r) => setTimeout(r, 300));
    expect(internalHits).toEqual([]);
  });
});

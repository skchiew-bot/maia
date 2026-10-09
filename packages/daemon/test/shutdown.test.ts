import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { afterEach, describe, expect, it } from 'vitest';
import type { AocModule } from '@aoc/kernel';
import { stopDaemon } from '../src/daemon';
import type { AocServer } from '../src/server';
import { bootTestServer, removeTempDirs, type TestServer } from './helpers';

const servers: TestServer[] = [];
afterEach(async () => {
  for (const t of servers.splice(0)) await t.close();
  removeTempDirs();
});

function listen(aoc: AocServer): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: aoc.app.fetch, hostname: '127.0.0.1', port: 0 }, (info: AddressInfo) =>
      resolve({ server: server as Server, url: `http://127.0.0.1:${info.port}` }),
    );
  });
}

describe('stopping aocd', () => {
  it('lets the modules wind down while the server still answers (a sidecar sends its last usage through it), then stops accepting', async () => {
    let url = '';
    const reachable = (): Promise<string> =>
      fetch(`${url}/api/health`).then(
        (r) => String(r.status),
        () => 'refused',
      );
    const seen: string[] = [];
    const probe: AocModule = {
      name: 'probe',
      async quiesce() {
        seen.push(`quiesce: ${await reachable()}`);
      },
      async stop() {
        seen.push(`stop: ${await reachable()}`);
      },
    };
    const t = await bootTestServer({ modules: [probe] });
    servers.push(t);
    const listening = await listen(t.aoc);
    url = listening.url;

    await stopDaemon(listening.server, t.aoc);
    expect(seen).toEqual(['quiesce: 200', 'stop: refused']);
  });
});

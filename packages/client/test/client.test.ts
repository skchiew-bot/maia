import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createClient } from '../src';

let server: Server | null = null;
afterEach(() => server?.close());

function serve(handler: (path: string, body: string) => [number, unknown]): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        const [status, json] = handler(req.url ?? '', b);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      });
    }).listen(0, '127.0.0.1', () => {
      const a = server!.address() as { port: number };
      resolve(`http://127.0.0.1:${a.port}`);
    });
  });
}

describe('AocClient', () => {
  it('posts with auth and returns data', async () => {
    const url = await serve((p, b) => [200, { path: p, body: JSON.parse(b) }]);
    const c = createClient({ daemonUrl: url, token: 't0k' });
    const r = await c.post<{ path: string }>('/ingest/hook', { a: 1 });
    expect(r.ok && r.data.path).toBe('/ingest/hook');
  });

  it('spools on network failure and flushes through /ingest/spool', async () => {
    const spoolDir = mkdtempSync(join(tmpdir(), 'aoc-spool-'));
    const down = createClient({ daemonUrl: 'http://127.0.0.1:1', spoolDir, retries: 1, timeoutMs: 500 });
    const r = await down.post('/ingest/hook', { x: 1 }, { spool: true });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.spooled).toBe(true);
    expect(down.spooledCount()).toBe(1);
    const seen: unknown[] = [];
    const url = await serve((p, b) => {
      seen.push({ p, b: JSON.parse(b) });
      return [200, { accepted: 1, duplicates: 0, rejected: 0 }];
    });
    const up = createClient({ daemonUrl: url, spoolDir });
    expect(await up.flushSpool()).toEqual({ sent: 1, failed: 0, rejected: 0 });
    expect(up.spooledCount()).toBe(0);
    expect((seen[0] as { p: string }).p).toBe('/ingest/spool');
  });

  it('does not retry 4xx', async () => {
    let n = 0;
    const url = await serve(() => (n++, [403, { error: { message: 'nope' } }]));
    const r = await createClient({ daemonUrl: url, retries: 3 }).post('/x', {});
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe('nope');
    expect(n).toBe(1);
  });
});

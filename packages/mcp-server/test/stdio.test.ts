import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { AOC_MCP_TOOL_NAMES } from '@aoc/contracts';
import { readMcpServerEnv } from '../src/env';
import { startFakeDaemon, type FakeDaemon } from './fake-daemon';

const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = ['--import', 'tsx', fileURLToPath(new URL('../src/main.ts', import.meta.url))];
const FULL_ENV = {
  AOC_SESSION_ID: 'ses_stdio',
  AOC_DAEMON_URL: 'http://127.0.0.1:7420',
  AOC_INGEST_TOKEN: 'tok_stdio',
};

interface Exit {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the stdio entry with `input` piped in and stdin then closed, so a server that wrongly started exits instead of hanging. */
function runEntry(env: Record<string, string>, input = ''): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ENTRY, {
      cwd: PKG_DIR,
      env: { ...getDefaultEnvironment(), ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

const jsonRpcLines = (...messages: object[]) =>
  messages.map((m) => JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n').join('');

describe('stdio entry refuses to start without its env', () => {
  it('exits 1 naming every missing variable, with nothing on stdout', async () => {
    const r = await runEntry({});
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('missing AOC_SESSION_ID, AOC_DAEMON_URL, AOC_INGEST_TOKEN');
    expect(r.stderr).toContain('refusing to start');
  });

  it('never starts unauthenticated: a missing ingest token alone is fatal', async () => {
    const { AOC_INGEST_TOKEN: _omitted, ...withoutToken } = FULL_ENV;
    const r = await runEntry(withoutToken);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('missing AOC_INGEST_TOKEN');
  });
});

describe('readMcpServerEnv', () => {
  it('accepts a complete env (trimming whitespace)', () => {
    expect(readMcpServerEnv({ ...FULL_ENV, AOC_INGEST_TOKEN: ' tok_stdio \n' })).toEqual({
      ok: true,
      env: { sessionId: 'ses_stdio', daemonUrl: 'http://127.0.0.1:7420', token: 'tok_stdio' },
    });
  });

  it.each(Object.keys(FULL_ENV))('rejects a missing or blank %s', (name) => {
    expect(readMcpServerEnv({ ...FULL_ENV, [name]: undefined })).toEqual({
      ok: false,
      problems: [`missing ${name}`],
    });
    expect(readMcpServerEnv({ ...FULL_ENV, [name]: '   ' })).toEqual({
      ok: false,
      problems: [`missing ${name}`],
    });
  });

  it.each(['localhost:7420', 'file:///tmp/aocd.sock', 'not a url'])(
    'rejects a daemon URL that is not http(s): %s',
    (url) => {
      expect(readMcpServerEnv({ ...FULL_ENV, AOC_DAEMON_URL: url })).toEqual({
        ok: false,
        problems: ['AOC_DAEMON_URL must be an http(s) URL'],
      });
    },
  );
});

describe('stdio entry serving a managed session', () => {
  let daemon: FakeDaemon | null = null;
  let mcp: Client | null = null;
  afterEach(async () => {
    await mcp?.close();
    await daemon?.close();
    mcp = daemon = null;
  });

  it('speaks MCP over stdio as `aoc` and relays calls with the session id and bearer token', async () => {
    const status = { ok: true, manifest: null, progress: null, decisions: [], lessons: [] };
    daemon = await startFakeDaemon(() => ({ status: 200, body: status }));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ENTRY,
      cwd: PKG_DIR,
      env: { ...getDefaultEnvironment(), ...FULL_ENV, AOC_DAEMON_URL: daemon.url },
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (c) => (stderr += c));
    mcp = new Client({ name: 'aoc-stdio-test', version: '0.0.0' });
    await mcp.connect(transport);

    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(mcp.getServerVersion()).toMatchObject({ name: 'aoc', version: pkg.version });
    expect((await mcp.listTools()).tools.map((t) => t.name)).toEqual(AOC_MCP_TOOL_NAMES);

    const r = await mcp.callTool({ name: 'get_status', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual(status);
    expect(daemon.requests).toEqual([
      {
        method: 'POST',
        path: '/ingest/mcp/get_status',
        authorization: 'Bearer tok_stdio',
        contentType: 'application/json',
        body: { sessionId: 'ses_stdio', input: {} },
      },
    ]);
    expect(stderr).toContain('serving session ses_stdio');
    expect(stderr).not.toContain('tok_stdio');
  });

  it('still answers a call in flight when stdin closes, keeps stdout pure JSON-RPC, then exits 0', async () => {
    daemon = await startFakeDaemon(() => ({ status: 200, body: { ok: true }, delayMs: 300 }));
    const input = jsonRpcLines(
      {
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'pipe', version: '0' },
        },
      },
      { method: 'notifications/initialized' },
      {
        id: 2,
        method: 'tools/call',
        params: {
          name: 'task_done',
          arguments: { task_id: 't1', evidence: { kind: 'commit', ref: 'abc123' } },
        },
      },
    );
    const r = await runEntry({ ...FULL_ENV, AOC_DAEMON_URL: daemon.url }, input);
    expect(r.code).toBe(0);
    const replies = r.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { id: number; result: { isError?: boolean } });
    expect(replies.map((m) => m.id)).toEqual([1, 2]);
    expect(replies[1]!.result.isError).toBeFalsy();
    expect(daemon.requests).toHaveLength(1);
  });
});

#!/usr/bin/env node
// Stand-in for the AOC hook and MCP binaries in isolation tests: `fake-helper.mjs hook <Event>` or
// `fake-helper.mjs mcp`. Each run appends {role, event, uid, home} to $FAKE_HELPER_LOG_DIR/<uid>.jsonl (one file
// per uid, so different session users never share a file); as `mcp` it completes the MCP stdio handshake with
// no tools, so claude reports the aoc server as connected.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const [role, event] = process.argv.slice(2);
const dir = process.env.FAKE_HELPER_LOG_DIR;
if (dir) {
  const entry = { role, event: event ?? null, uid: process.getuid(), home: process.env.HOME ?? null };
  appendFileSync(join(dir, `${process.getuid()}.jsonl`), `${JSON.stringify(entry)}\n`);
}

if (role === 'mcp') {
  const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id === undefined) return;
    if (m.method === 'initialize')
      send({
        id: m.id,
        result: {
          protocolVersion: m.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'aoc', version: '0.0.0-test' },
        },
      });
    else if (m.method === 'tools/list') send({ id: m.id, result: { tools: [] } });
    else send({ id: m.id, error: { code: -32601, message: `unsupported: ${m.method}` } });
  });
  rl.on('close', () => process.exit(0));
} else {
  // A hook: consume the event JSON, allow by saying nothing.
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: unknown;
}

/** A reply (optionally delayed), or 'hang' to never answer (timeout tests). */
export type Reply = { status: number; body?: unknown; delayMs?: number } | 'hang';
export type Responder = (req: RecordedRequest, nth: number) => Reply;

export interface FakeDaemon {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

const echo: Responder = (req) => ({ status: 200, body: { ok: true, path: req.path } });

export async function startFakeDaemon(responder: Responder = echo): Promise<FakeDaemon> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: raw ? JSON.parse(raw) : null,
      };
      requests.push(recorded);
      const reply = responder(recorded, requests.length);
      if (reply === 'hang') return;
      setTimeout(() => {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
      }, reply.delayMs ?? 0);
    });
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, requests, close: () => stop(server) };
}

/** A URL nothing listens on (an ephemeral port that was bound and released). */
export async function unreachableUrl(): Promise<string> {
  const server = createServer();
  const port = await listen(server);
  await stop(server);
  return `http://127.0.0.1:${port}`;
}

/** The daemon's standard error envelope (kernel `errorResponse`). */
export function daemonError(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );
}

function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

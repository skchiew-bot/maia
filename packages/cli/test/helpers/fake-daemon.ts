import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';

export interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingHttpHeaders;
  body: unknown;
}
export interface Reply {
  status?: number;
  json?: unknown;
  body?: string | Uint8Array;
  contentType?: string;
}
export type Responder = Reply | ((req: Recorded) => Reply);

/**
 * Minimal aocd stand-in on 127.0.0.1:<random port>. Routes answer with a sequence of responders (the last
 * one repeats); unknown routes get the daemon's JSON 404 envelope. Every request is recorded.
 */
export class FakeDaemon {
  readonly requests: Recorded[] = [];
  private readonly routes = new Map<string, Responder[]>();
  private server: Server | null = null;
  url = '';

  on(method: string, path: string, ...responders: Responder[]): this {
    this.routes.set(`${method} ${path}`, responders);
    return this;
  }

  calls(method: string, path: string): Recorded[] {
    return this.requests.filter((r) => r.method === method && r.path === path);
  }

  start(): Promise<this> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const u = new URL(req.url ?? '/', 'http://x');
          const raw = Buffer.concat(chunks).toString('utf8');
          const rec: Recorded = {
            method: req.method ?? 'GET',
            path: u.pathname,
            query: Object.fromEntries(u.searchParams),
            headers: req.headers,
            body: raw ? JSON.parse(raw) : undefined,
          };
          this.requests.push(rec);
          const list = this.routes.get(`${rec.method} ${rec.path}`);
          const responder = list ? (list.length > 1 ? list.shift()! : list[0]!) : null;
          const reply: Reply = responder
            ? typeof responder === 'function'
              ? responder(rec)
              : responder
            : {
                status: 404,
                json: { error: { code: 'not_found', message: `no route ${rec.method} ${rec.path}` } },
              };
          const body = reply.json !== undefined ? JSON.stringify(reply.json) : (reply.body ?? '');
          res.writeHead(reply.status ?? 200, {
            'content-type':
              reply.contentType ?? (reply.json !== undefined ? 'application/json' : 'text/plain'),
          });
          res.end(body);
        });
      }).listen(0, '127.0.0.1', () => {
        const a = this.server!.address() as { port: number };
        this.url = `http://127.0.0.1:${a.port}`;
        resolve(this);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

export async function startFakeDaemon(): Promise<FakeDaemon> {
  return new FakeDaemon().start();
}

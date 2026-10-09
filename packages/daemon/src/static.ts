import { existsSync, statSync, type Stats } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { Context, Hono } from 'hono';
import type { AppEnv } from '@aoc/kernel';
import { isApiPath } from './http';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/** Vite emits content-hashed files under /assets/; everything else must be revalidated. */
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';

/** Places the built UI may live: `<dist>/web` beside `<dist>/bin`, or the web package's own dist in a checkout. */
export function webDirCandidates(binDir: string, repoRoot: string | null): string[] {
  return [
    join(binDir, '..', 'web'),
    join(binDir, 'web'),
    ...(repoRoot ? [join(repoRoot, 'packages', 'web', 'dist')] : []),
  ];
}

export function resolveWebDir(candidates: readonly string[]): string | null {
  const dir = candidates.find((d) => existsSync(join(d, 'index.html')));
  return dir ? resolve(dir) : null;
}

/**
 * Serve the console/portal SPA for every GET the API did not answer. Deep links fall back to
 * index.html (`/portal/*` prefers a separate portal entry when the build has one); a missing file
 * (last segment has an extension), a dotfile or a traversal attempt is a 404 rather than HTML.
 */
export function mountStatic(app: Hono<AppEnv>, webDir: string | null): void {
  app.get('*', async (c) => {
    const path = c.req.path;
    if (isApiPath(path)) return c.notFound();
    if (!webDir) return uiNotBuilt(c);
    const segments = pathSegments(path);
    if (!segments) return c.notFound();
    const file = resolve(webDir, ...segments);
    const st = file.startsWith(webDir + sep) ? statOrNull(file) : null;
    if (st?.isFile()) return serveFile(c, file, st, path.startsWith('/assets/') ? IMMUTABLE : REVALIDATE);
    if (/\.[A-Za-z0-9]+$/.test(segments.at(-1) ?? '')) return c.notFound();
    const entry = spaEntry(webDir, path);
    const entrySt = statOrNull(entry);
    return entrySt?.isFile() ? serveFile(c, entry, entrySt, REVALIDATE) : uiNotBuilt(c);
  });
}

/** Decoded path segments, or null for anything that could escape the web root or reach a dotfile. */
function pathSegments(path: string): string[] | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const segments = decoded.split('/').filter(Boolean);
  return segments.some((s) => s.startsWith('.')) ? null : segments;
}

function spaEntry(webDir: string, path: string): string {
  if (path === '/portal' || path.startsWith('/portal/')) {
    const portal = ['portal/index.html', 'portal.html']
      .map((f) => join(webDir, f))
      .find((f) => existsSync(f));
    if (portal) return portal;
  }
  return join(webDir, 'index.html');
}

async function serveFile(
  c: Context<AppEnv>,
  file: string,
  st: Stats,
  cacheControl: string,
): Promise<Response> {
  const headers = {
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': cacheControl,
    etag: `W/"${st.size.toString(16)}-${Math.trunc(st.mtimeMs).toString(16)}"`,
  };
  if (c.req.header('if-none-match') === headers.etag) return new Response(null, { status: 304, headers });
  return new Response(await readFile(file), { headers });
}

function statOrNull(file: string): Stats | null {
  try {
    return statSync(file);
  } catch {
    return null;
  }
}

function uiNotBuilt(c: Context<AppEnv>): Response {
  return c.text(
    'The AOC console UI is not built. Run `pnpm build` (node scripts/build.mjs) and restart aocd.',
    503,
  );
}

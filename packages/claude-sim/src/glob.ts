import fs from 'node:fs';
import path from 'node:path';

const escapeRegex = (text: string): string => text.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/** Regex source for a glob: `**` crosses directories, `*`/`?` stay within one, `{a,b}` and `[...]` work. */
function globSource(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        const atSegmentStart = i === 0 || glob[i - 1] === '/';
        if (atSegmentStart && glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if (char === '{') {
      const close = glob.indexOf('}', i);
      if (close === -1) {
        out += '\\{';
        continue;
      }
      const alternatives = glob
        .slice(i + 1, close)
        .split(',')
        .map(globSource);
      out += `(?:${alternatives.join('|')})`;
      i = close;
    } else if (char === '[') {
      const close = glob.indexOf(']', i + 1);
      if (close === -1) {
        out += '\\[';
        continue;
      }
      const body = glob
        .slice(i + 1, close)
        .replace(/^!/, '^')
        .replace(/\\/g, '\\\\');
      out += `[${body}]`;
      i = close;
    } else {
      out += escapeRegex(char);
    }
  }
  return out;
}

export function globToRegExp(glob: string, flags = ''): RegExp {
  return new RegExp(`^${globSource(glob)}$`, flags);
}

const SKIPPED_DIRS = new Set(['.git', 'node_modules']);
const MAX_WALK_ENTRIES = 20_000;

/** Files under `root` (relative paths, '/'-separated), skipping .git and node_modules. */
export function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [''];
  while (stack.length > 0 && out.length < MAX_WALK_ENTRIES) {
    const rel = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) stack.push(child);
      } else if (entry.isFile()) {
        out.push(child);
      }
    }
  }
  return out.sort();
}

export function mtimeOf(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

import { describe, expect, it } from 'vitest';
import { errorSignature, normalizeMessage, toolErrorText } from '../src';
import { areasOverlap, codeAreaOfFile, normalizeScopeValue, pathUnder, toCodeArea } from '../src/scope';

describe('signature normalisation', () => {
  it('strips numbers, hex, ids, paths, quoted values and timestamps so one template has one signature', () => {
    const same: [string, string][] = [
      [
        "Error: ENOENT: no such file or directory, open '/home/alice/app/config.json'",
        "Error: ENOENT: no such file or directory, open '/srv/build/7/settings.yaml'",
      ],
      [
        'Timeout after 3000ms at 2026-10-09T01:02:03Z (req 0x7f3a)',
        'Timeout after 15000ms at 2026-10-11T23:59:59.123+08:00 (req 0x1b)',
      ],
      ["Cannot find module 'react'", 'Cannot find module "lodash/fp"'],
      ['commit 3f585b8a1c not found in refs', 'commit 9e8d7c6b5a4f3e2d1c0b not found in refs'],
      [
        'session ses_01JABCDEFGHJKMNPQRSTVWXYZ0 lost heartbeat at 10:22:31',
        'session ses_01JZZZZZZZZZZZZZZZZZZZZZZZ lost heartbeat at 09:01:02.5',
      ],
      [
        'src/app/routes/index.ts(12,5): error TS2345: bad arg',
        'packages/web/src/x.tsx(140,22): error TS2345: bad arg',
      ],
      [
        'request 550e8400-e29b-41d4-a716-446655440000 failed with 503',
        'request 123e4567-e89b-12d3-a456-426614174000 failed with 502',
      ],
      [
        'GET https://api.example.com/v1/items?id=4 returned 500',
        'GET http://localhost:7420/api/x returned 504',
      ],
    ];
    for (const [a, b] of same) {
      expect(normalizeMessage(a)).toBe(normalizeMessage(b));
      expect(errorSignature(a)).toBe(errorSignature(b));
    }
    expect(
      normalizeMessage("Error: ENOENT: no such file or directory, open '/home/alice/app/config.json'"),
    ).toBe('error: enoent: no such file or directory, open <q>');
    expect(normalizeMessage('Timeout after 3000ms at 2026-10-09T01:02:03Z (req 0x7f3a)')).toBe(
      'timeout after <n> ms at <ts> (req <hex> )',
    );
    expect(errorSignature('x')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps different failure templates apart and does not treat contractions as quotes', () => {
    expect(errorSignature('permission denied (publickey)')).not.toBe(errorSignature('connection refused'));
    expect(errorSignature("Can't resolve 'foo' in /app/src")).not.toBe(
      errorSignature("Can't connect to 'foo' in /app/src"),
    );
    expect(normalizeMessage("Can't resolve 'foo' in /app/src")).toBe("can't resolve <q> in <path>");
  });

  it('extracts the human error text from JSON tool output (whole or truncated)', () => {
    expect(toolErrorText('{"stdout":"","stderr":"npm ERR! missing script: test","interrupted":false}')).toBe(
      'npm ERR! missing script: test',
    );
    expect(toolErrorText('{"is_error":true,"content":[{"type":"text","text":"File does not exist."}]}')).toBe(
      'File does not exist.',
    );
    expect(
      toolErrorText('{"stdout":"ok","stderr":"Error: boom \\"x\\" happened and then a very long tail…'),
    ).toBe('Error: boom "x" happened and then a very long tail…');
    expect(toolErrorText('plain failure text')).toBe('plain failure text');
    expect(toolErrorText('')).toBeNull();
    // two different tool failures must not collapse onto one signature
    const a = toolErrorText('{"stderr":"EACCES: permission denied, open \'/x\'"}')!;
    const b = toolErrorText('{"stderr":"ECONNREFUSED 127.0.0.1:5432"}')!;
    expect(errorSignature(a)).not.toBe(errorSignature(b));
  });
});

describe('code areas and scopes', () => {
  it('keeps code areas repo-relative and never global', () => {
    expect(toCodeArea('/work/repo/packages/web/src', '/work/repo')).toBe('packages/web/src');
    expect(toCodeArea('/home/alice/elsewhere/x', '/work/repo')).toBeNull(); // absolute paths outside the repo carry personal data
    expect(toCodeArea('./packages/web/')).toBe('packages/web');
    expect(toCodeArea('../etc')).toBeNull();
    expect(toCodeArea('.')).toBeNull();
    expect(toCodeArea('/')).toBeNull();
    expect(codeAreaOfFile('/work/repo/packages/web/src/App.tsx', '/work/repo')).toBe('packages/web/src');
    expect(normalizeScopeValue('code_area', '**')).toBeNull();
    expect(normalizeScopeValue('process_type', 'bug-fix')).toBe('bug-fix');
    expect(normalizeScopeValue('process_type', 'all types!')).toBeNull();
  });

  it('matches paths on whole segments', () => {
    expect(pathUnder('/work/repo/packages/web/src/a.ts', 'packages/web')).toBe(true);
    expect(pathUnder('packages/web', 'packages/web')).toBe(true);
    expect(pathUnder('/work/repo/packages/webapp/a.ts', 'packages/web')).toBe(false);
    expect(areasOverlap('packages/web/src/pages', 'packages/web')).toBe(true);
    expect(areasOverlap('packages/web', 'packages/web/src')).toBe(true);
    expect(areasOverlap('packages/kernel', 'packages/web')).toBe(false);
  });
});

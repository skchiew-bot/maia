import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeMapping } from '../src/mapping';
import { removeTempDirs, repoRoot, tempDir } from './helpers';

afterEach(() => removeTempDirs());

const shipped = join(repoRoot, 'config', 'iso42001-mapping.json');
const shippedVersion = (JSON.parse(readFileSync(shipped, 'utf8')) as { version: string }).version;

describe('the startup line that names the ISO 42001 mapping aocd runs with', () => {
  it('names the file when it is loaded, with its version', () => {
    expect(describeMapping(shipped)).toBe(`${shipped} (version ${shippedVersion})`);
  });

  it('says so, and names the path it looked at, when there is no file and the built-in default is used', () => {
    const missing = join(tempDir(), 'config', 'iso42001-mapping.json');
    const line = describeMapping(missing);
    expect(line).toContain('built-in default');
    expect(line).toContain(`no file at ${missing}`);
    expect(line).not.toContain('(version undefined)');
  });

  it('says so when the file is there but rejected', () => {
    const bad = join(tempDir(), 'iso42001-mapping.json');
    writeFileSync(bad, '{"version":"draft"}');
    const line = describeMapping(bad);
    expect(line).toContain('built-in default');
    expect(line).toContain(`${bad} was rejected`);
  });
});

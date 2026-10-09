import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CLAUDE_SIM_BIN, claudeSimProblem } from '../src/sim-guard';

const dir = mkdtempSync(join(tmpdir(), 'aoc-demo-guard-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('claudeSimProblem', () => {
  it('accepts node running claude-sim (what the seeder writes)', () => {
    expect(claudeSimProblem({ claudeBin: process.execPath, claudeArgsPrefix: [CLAUDE_SIM_BIN] }, dir)).toBeNull();
    expect(claudeSimProblem({ claudeBin: 'node', claudeArgsPrefix: ['--no-warnings', CLAUDE_SIM_BIN] }, dir)).toBeNull();
  });

  it('accepts the claude-sim bundle built next to aocd', () => {
    const bin = join(dir, 'dist', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'aocd.mjs'), '');
    writeFileSync(join(bin, 'claude-sim.mjs'), '#!/usr/bin/env node\n');
    chmodSync(join(bin, 'claude-sim.mjs'), 0o755);
    expect(claudeSimProblem({ claudeBin: join(bin, 'claude-sim.mjs'), claudeArgsPrefix: [] }, dir)).toBeNull();
    expect(claudeSimProblem({ claudeBin: './dist/bin/claude-sim.mjs', claudeArgsPrefix: [] }, dir)).toBeNull();
  });

  it('refuses the real claude CLI and anything that is not claude-sim', () => {
    expect(claudeSimProblem({ claudeBin: 'claude', claudeArgsPrefix: [] }, dir)).toMatch(/refuses to start/);
    expect(claudeSimProblem({ claudeBin: '/usr/local/bin/claude', claudeArgsPrefix: [] }, dir)).toMatch(/not node running claude-sim/);
    const fakeCli = join(dir, 'cli.js');
    writeFileSync(fakeCli, '');
    expect(claudeSimProblem({ claudeBin: process.execPath, claudeArgsPrefix: [fakeCli] }, dir)).toMatch(/is not claude-sim/);
    expect(claudeSimProblem({ claudeBin: process.execPath, claudeArgsPrefix: [] }, dir)).toMatch(/no claude-sim script/);
    expect(claudeSimProblem({ claudeBin: process.execPath, claudeArgsPrefix: ['--import', CLAUDE_SIM_BIN] }, dir)).toMatch(/no claude-sim script/);
    // A file merely named like the bundle, away from the AOC binaries, is not trusted.
    writeFileSync(join(dir, 'claude-sim.mjs'), '');
    expect(claudeSimProblem({ claudeBin: join(dir, 'claude-sim.mjs'), claudeArgsPrefix: [] }, dir)).toMatch(/refuses to start/);
  });
});

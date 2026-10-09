import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOOK_EVENTS } from '@aoc/contracts';
import {
  AOC_HOOK_TAG,
  inspectObservedHooks,
  installObservedHooks,
  isAocHandler,
  mergeObservedHooks,
  removeObservedHooks,
  tagCommand,
  uninstallObservedHooks,
} from '../src/observed-hooks';
import { aoc, tempDir, writeClientConfig } from './helpers/cli';

const CMD = 'node /opt/aoc/aoc-hook.mjs';
const foreignPre = { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-linter --check' }] };
const foreignStop = { hooks: [{ type: 'command', command: 'notify-send done', timeout: 3 }] };
const userSettings = () => ({
  model: 'opus',
  permissions: { allow: ['Bash(ls:*)'] },
  hooks: { PreToolUse: [foreignPre], Stop: [foreignStop] },
  env: { FOO: '1' },
});

type Groups = { matcher?: string; hooks: { command: string; timeout?: number; type: string }[] }[];
const hooksOf = (s: Record<string, unknown>) => s.hooks as Record<string, Groups>;

describe('mergeObservedHooks', () => {
  it('registers every hook event with the tagged command (tool events match "*")', () => {
    const { settings, changed } = mergeObservedHooks({}, CMD);
    expect(changed).toBe(true);
    const hooks = hooksOf(settings);
    expect(Object.keys(hooks).sort()).toEqual([...HOOK_EVENTS].sort());
    expect(hooks.PreToolUse).toEqual([
      { matcher: '*', hooks: [{ type: 'command', command: `${CMD} ${AOC_HOOK_TAG}`, timeout: 10 }] },
    ]);
    expect(hooks.SessionStart).toEqual([
      { hooks: [{ type: 'command', command: `${CMD} ${AOC_HOOK_TAG}`, timeout: 10 }] },
    ]);
  });

  it('preserves foreign hooks (in order) and unrelated settings', () => {
    const input = userSettings();
    const { settings } = mergeObservedHooks(input, CMD);
    expect(settings.model).toBe('opus');
    expect(settings.env).toEqual({ FOO: '1' });
    expect(settings.permissions).toEqual({ allow: ['Bash(ls:*)'] });
    const hooks = hooksOf(settings);
    expect(hooks.PreToolUse![0]).toEqual(foreignPre);
    expect(isAocHandler(hooks.PreToolUse![1]!.hooks[0])).toBe(true);
    expect(hooks.Stop![0]).toEqual(foreignStop);
    expect(input).toEqual(userSettings()); // pure: input untouched
  });

  it('is idempotent', () => {
    const once = mergeObservedHooks(userSettings(), CMD).settings;
    const twice = mergeObservedHooks(once, CMD);
    expect(twice.changed).toBe(false);
    expect(twice.settings).toEqual(once);
  });

  it('re-installing a different command replaces it in place (one AOC handler per event)', () => {
    const once = mergeObservedHooks(userSettings(), CMD).settings;
    const { settings, changed } = mergeObservedHooks(once, '/usr/local/bin/aoc-hook');
    expect(changed).toBe(true);
    const pre = hooksOf(settings).PreToolUse!;
    expect(pre).toHaveLength(2);
    expect(pre[1]!.hooks[0]!.command).toBe(`/usr/local/bin/aoc-hook ${AOC_HOOK_TAG}`);
    expect(inspectObservedHooks(settings).commands).toEqual(['/usr/local/bin/aoc-hook']);
  });

  it('splits an AOC handler out of a group shared with foreign handlers', () => {
    const mixed = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: 'a' },
              { type: 'command', command: `old ${AOC_HOOK_TAG}` },
            ],
          },
        ],
      },
    };
    const stop = hooksOf(mergeObservedHooks(mixed, CMD).settings).Stop!;
    expect(stop).toEqual([
      { hooks: [{ type: 'command', command: 'a' }] },
      { hooks: [{ type: 'command', command: tagCommand(CMD), timeout: 10 }] },
    ]);
  });

  it('does not double-tag an already tagged command', () => {
    expect(tagCommand(tagCommand(CMD))).toBe(`${CMD} ${AOC_HOOK_TAG}`);
  });

  it('refuses malformed hook sections instead of clobbering them', () => {
    expect(() => mergeObservedHooks({ hooks: [] }, CMD)).toThrow(/not an object/);
    expect(() => mergeObservedHooks({ hooks: { Stop: {} } }, CMD)).toThrow(/hooks\.Stop is not an array/);
    expect(() => mergeObservedHooks([], CMD)).toThrow(/not a JSON object/);
  });
});

describe('removeObservedHooks', () => {
  it('removes only AOC handlers, dropping groups/events it emptied, and is idempotent', () => {
    const installed = mergeObservedHooks(userSettings(), CMD).settings;
    const first = removeObservedHooks(installed);
    expect(first.removed).toBe(HOOK_EVENTS.length);
    expect(first.settings).toEqual(userSettings());
    const second = removeObservedHooks(first.settings);
    expect(second).toMatchObject({ removed: 0, changed: false });
    expect(second.settings).toEqual(userSettings());
  });

  it('drops the hooks key when only AOC hooks were there', () => {
    const { settings } = removeObservedHooks(mergeObservedHooks({ model: 'x' }, CMD).settings);
    expect(settings).toEqual({ model: 'x' });
  });

  it('keeps foreign handlers that shared a group with an AOC handler', () => {
    const mixed = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: 'a' },
              { type: 'command', command: `x ${AOC_HOOK_TAG}` },
            ],
          },
        ],
      },
    };
    expect(removeObservedHooks(mixed).settings).toEqual({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'a' }] }] },
    });
  });
});

describe('inspectObservedHooks', () => {
  it('reports installed and missing events', () => {
    const settings = mergeObservedHooks({}, CMD, ['PreToolUse', 'Stop']).settings;
    const r = inspectObservedHooks(settings);
    expect(r.installed).toEqual(['PreToolUse', 'Stop']);
    expect(r.missing).toHaveLength(HOOK_EVENTS.length - 2);
    expect(r.commands).toEqual([CMD]);
    expect(inspectObservedHooks(null).installed).toEqual([]);
  });
});

describe('settings file install/uninstall', () => {
  it('backs up the original bytes, writes atomically keeping the mode, and does not rewrite when unchanged', () => {
    const dir = tempDir();
    const file = join(dir, 'settings.json');
    const original = JSON.stringify(userSettings(), null, 4);
    writeFileSync(file, original, { mode: 0o644 });

    const first = installObservedHooks(file, CMD);
    expect(first.changed).toBe(true);
    expect(first.backupPath).toBe(`${file}.aoc-bak`);
    expect(readFileSync(`${file}.aoc-bak`, 'utf8')).toBe(original);
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect(inspectObservedHooks(JSON.parse(readFileSync(file, 'utf8'))).missing).toEqual([]);

    const written = readFileSync(file, 'utf8');
    writeFileSync(`${file}.aoc-bak`, 'sentinel');
    const second = installObservedHooks(file, CMD);
    expect(second).toMatchObject({ changed: false, backupPath: null });
    expect(readFileSync(file, 'utf8')).toBe(written);
    expect(readFileSync(`${file}.aoc-bak`, 'utf8')).toBe('sentinel');

    const removed = uninstallObservedHooks(file);
    expect(removed.removed).toBe(HOOK_EVENTS.length);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(userSettings());
    expect(uninstallObservedHooks(file).removed).toBe(0);
  });

  it('creates a missing settings file (0600) without a backup', () => {
    const file = join(tempDir(), 'nested', 'settings.json');
    expect(installObservedHooks(file, CMD)).toMatchObject({ changed: true, backupPath: null });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('refuses to touch a settings file that is not valid JSON', () => {
    const file = join(tempDir(), 'settings.json');
    writeFileSync(file, '{ "model": "opus", // comment\n}');
    expect(() => installObservedHooks(file, CMD)).toThrow(/not valid JSON/);
    expect(readFileSync(file, 'utf8')).toBe('{ "model": "opus", // comment\n}');
  });
});

describe('aoc hooks (command)', () => {
  it('install-observed merges the settings and stores the observer token in the 0600 client config', async () => {
    const home = tempDir();
    writeClientConfig(home, { daemonUrl: 'http://127.0.0.1:7420', token: 'aoc_u_keep' });
    const settings = join(home, 'custom', 'settings.json');
    const r = await aoc(
      [
        'hooks',
        'install-observed',
        '--settings',
        settings,
        '--command',
        CMD,
        '--observer-token',
        'aoc_o_OBS',
      ],
      { homeDir: home },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      `Installed AOC observed-session hooks for ${HOOK_EVENTS.length} events in ${settings}`,
    );
    expect(r.stdout + r.stderr).not.toContain('aoc_o_OBS');
    expect(inspectObservedHooks(JSON.parse(readFileSync(settings, 'utf8'))).missing).toEqual([]);
    const cfgPath = join(home, '.aoc', 'client.json');
    expect(JSON.parse(readFileSync(cfgPath, 'utf8'))).toEqual({
      daemonUrl: 'http://127.0.0.1:7420',
      token: 'aoc_u_keep',
      observerToken: 'aoc_o_OBS',
    });
    expect(statSync(cfgPath).mode & 0o777).toBe(0o600);

    const again = await aoc(['hooks', 'install-observed', '--settings', settings, '--command', CMD], {
      homeDir: home,
    });
    expect(again.stdout).toContain('already installed');
    expect(again.stderr).not.toContain('no observer token');

    const un = await aoc(['hooks', 'uninstall', '--settings', settings], { homeDir: home });
    expect(un.stdout).toContain(`Removed ${HOOK_EVENTS.length} AOC hook entries`);
  });

  it('defaults to ~/.claude/settings.json (or $CLAUDE_CONFIG_DIR) and the hook bundled next to the CLI', async () => {
    const home = tempDir();
    const cliDir = tempDir();
    writeFileSync(join(cliDir, 'aoc-hook.mjs'), '');
    const r = await aoc(['hooks', 'install-observed'], {
      homeDir: home,
      argv1: join(cliDir, 'aoc.mjs'),
      execPath: '/usr/bin/node',
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('no observer token configured');
    const s = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    expect(inspectObservedHooks(s).commands).toEqual([`/usr/bin/node ${join(cliDir, 'aoc-hook.mjs')}`]);

    const cfgDir = join(tempDir(), 'claude-cfg');
    mkdirSync(cfgDir);
    await aoc(['hooks', 'install-observed', '--command', CMD], {
      homeDir: home,
      env: { CLAUDE_CONFIG_DIR: cfgDir },
    });
    expect(
      inspectObservedHooks(JSON.parse(readFileSync(join(cfgDir, 'settings.json'), 'utf8'))).missing,
    ).toEqual([]);
  });

  it('exits 2 when no hook command can be found', async () => {
    const r = await aoc(['hooks', 'install-observed']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--command');
  });

  it('exits 1 without modifying an invalid settings file', async () => {
    const file = join(tempDir(), 'settings.json');
    writeFileSync(file, 'not json');
    const r = await aoc(['hooks', 'install-observed', '--settings', file, '--command', CMD]);
    expect(r.code).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe('not json');
  });
});

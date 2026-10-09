import { spawnSync } from 'node:child_process';
import { AOC_ENV, HOOK_EVENTS, INGEST_PATHS } from '@aoc/contracts';
import { describe, expect, it } from 'vitest';
import {
  OBSERVED_HOOK_PREFIX,
  REGISTERED_HOOK_EVENTS,
  buildHookSettings,
  isObservedHookCommand,
  mergeObservedHooks,
  removeObservedHooks,
  shellJoin,
  validateHookSettings,
  type HookSettings,
} from '../src';
import { ENV, PATHS } from '../src/constants';

const CMD = ['/usr/local/bin/node', '/opt/aoc/aoc-hook.js'];

const USER_SETTINGS = JSON.stringify(
  {
    model: 'opus',
    permissions: { allow: ['Bash(ls:*)'] },
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/my-guard', timeout: 5 }] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
    },
  },
  null,
  2,
);

const aocEntries = (settingsJson: string) =>
  Object.entries((JSON.parse(settingsJson) as { hooks: HookSettings }).hooks).flatMap(([event, groups]) =>
    groups.flatMap((g) =>
      g.hooks
        .filter((h) => isObservedHookCommand(h.command))
        .map((h) => ({ event, matcher: g.matcher, ...h })),
    ),
  );

describe('buildHookSettings', () => {
  it('registers every contract event plus the verified Claude Code 2.1 events, tool events with matcher ""', () => {
    const hooks = buildHookSettings(CMD);
    expect(Object.keys(hooks)).toEqual([...REGISTERED_HOOK_EVENTS]);
    for (const event of [
      ...HOOK_EVENTS,
      'PostToolUseFailure',
      'PostToolBatch',
      'PermissionRequest',
      'StopFailure',
      'SubagentStart',
      'PostCompact',
    ]) {
      expect(hooks[event], event).toHaveLength(1);
    }
    for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'])
      expect(hooks[event]![0]!.matcher).toBe('');
    expect(hooks.Stop![0]).not.toHaveProperty('matcher');
    expect(hooks.PreToolUse![0]!.hooks[0]).toEqual({
      type: 'command',
      command: '/usr/local/bin/node /opt/aoc/aoc-hook.js PreToolUse',
      timeout: 30,
    });
  });

  it('passes its own self-check (numeric timeouts, known events only)', () => {
    expect(validateHookSettings({ hooks: buildHookSettings(CMD) })).toEqual([]);
    expect(validateHookSettings({ hooks: buildHookSettings(CMD, { scope: 'observed' }) })).toEqual([]);
  });

  it('builds commands a POSIX shell runs with the right argv and the observed marker in the env', () => {
    const probe = [
      'sh',
      '-c',
      'printf "%s|%s|%s" "${AOC_HOOK_SCOPE:-none}" "$1" "$0"',
      "it's a 'quoted' arg",
    ];
    const managed = buildHookSettings(probe).SessionEnd![0]!.hooks[0]!.command;
    const observed = buildHookSettings(probe, { scope: 'observed' }).SessionEnd![0]!.hooks[0]!.command;
    expect(spawnSync('sh', ['-c', managed], { encoding: 'utf8' }).stdout).toBe(
      "none|SessionEnd|it's a 'quoted' arg",
    );
    expect(spawnSync('sh', ['-c', observed], { encoding: 'utf8' }).stdout).toBe(
      "observed|SessionEnd|it's a 'quoted' arg",
    );
    expect(observed.startsWith(OBSERVED_HOOK_PREFIX)).toBe(true);
    expect(shellJoin(['/opt/my tools/node', ''])).toBe("'/opt/my tools/node' ''");
  });

  it('rejects an empty command', () => {
    expect(() => buildHookSettings([])).toThrow(/empty/);
  });
});

describe('mergeObservedHooks / removeObservedHooks', () => {
  it('adds one tagged entry per event and keeps every foreign key and hook', () => {
    const merged = mergeObservedHooks(USER_SETTINGS, CMD);
    const parsed = JSON.parse(merged);
    expect(parsed.model).toBe('opus');
    expect(parsed.permissions).toEqual({ allow: ['Bash(ls:*)'] });
    expect(parsed.hooks.PreToolUse[0]).toEqual({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: '/usr/local/bin/my-guard', timeout: 5 }],
    });
    expect(parsed.hooks.Stop[0]).toEqual({ hooks: [{ type: 'command', command: 'say done' }] });
    const ours = aocEntries(merged);
    expect(ours.map((e) => e.event).sort()).toEqual([...REGISTERED_HOOK_EVENTS].sort());
    expect(ours.find((e) => e.event === 'PreToolUse')!.command).toBe(
      `${OBSERVED_HOOK_PREFIX}/usr/local/bin/node /opt/aoc/aoc-hook.js PreToolUse`,
    );
    expect(validateHookSettings(parsed)).toEqual([]);
  });

  it('is idempotent and uninstalls exactly what it installed', () => {
    const merged = mergeObservedHooks(USER_SETTINGS, CMD);
    expect(mergeObservedHooks(merged, CMD)).toBe(merged);
    const removed = removeObservedHooks(merged);
    expect(JSON.parse(removed)).toEqual(JSON.parse(USER_SETTINGS));
    expect(removeObservedHooks(removed)).toBe(removed);
    expect(removeObservedHooks(USER_SETTINGS)).toBe(USER_SETTINGS);
  });

  it('replaces entries from an earlier install (new binary path) instead of duplicating them', () => {
    const upgraded = mergeObservedHooks(mergeObservedHooks(USER_SETTINGS, CMD), ['/opt/aoc-2/aoc-hook']);
    const ours = aocEntries(upgraded);
    expect(ours).toHaveLength(REGISTERED_HOOK_EVENTS.length);
    expect(ours.every((e) => e.command.startsWith(`${OBSERVED_HOOK_PREFIX}/opt/aoc-2/aoc-hook `))).toBe(true);
  });

  it('starts from empty or missing settings and leaves a hook the user added inside an AOC group', () => {
    const fresh = mergeObservedHooks(null, CMD);
    expect(Object.keys(JSON.parse(fresh))).toEqual(['hooks']);
    expect(removeObservedHooks(fresh)).toBe('{}\n');
    expect(JSON.parse(mergeObservedHooks('  \n', CMD)).hooks.Stop).toHaveLength(1);

    const edited = JSON.parse(fresh);
    edited.hooks.Stop[0].hooks.push({ type: 'command', command: 'notify-send stopped' });
    const after = JSON.parse(removeObservedHooks(JSON.stringify(edited, null, 2)));
    expect(after).toEqual({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-send stopped' }] }] },
    });
  });

  it('keeps the file indentation', () => {
    const tabbed = JSON.stringify(JSON.parse(USER_SETTINGS), null, '\t');
    expect(mergeObservedHooks(tabbed, CMD)).toMatch(/^\{\n\t"model"/);
  });

  it('refuses to rewrite settings it cannot parse safely', () => {
    expect(() => mergeObservedHooks('{"hooks": ', CMD)).toThrow(/not valid JSON/);
    expect(() => mergeObservedHooks('[]', CMD)).toThrow(/not a JSON object/);
    expect(() => mergeObservedHooks('{"hooks": []}', CMD)).toThrow(/settings.hooks is not an object/);
    expect(() => removeObservedHooks('{"hooks": {"Stop": {}}}')).toThrow(
      /settings.hooks.Stop is not an array/,
    );
  });
});

describe('validateHookSettings', () => {
  it('flags what Claude Code would silently drop', () => {
    const problems = validateHookSettings({
      hooks: {
        BogusEvent: [{ hooks: [{ type: 'command', command: 'x' }] }],
        Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'x', timeout: 'thirty' }] }],
        PreToolUse: [{ matcher: 3, hooks: [{ type: 'command', command: '' }] }],
        SessionEnd: {},
      },
    });
    expect(problems).toEqual([
      'hooks.BogusEvent: unknown hook event (Claude Code ignores it)',
      'hooks.Stop[0].hooks[0].timeout: not a positive number of seconds',
      'hooks.PreToolUse[0].matcher: not a string',
      'hooks.PreToolUse[0].hooks[0].command: empty or not a string',
      'hooks.SessionEnd: not an array of matcher groups',
    ]);
    expect(validateHookSettings({})).toEqual([]);
    expect(validateHookSettings('nope')).toEqual(['settings: not a JSON object']);
  });
});

describe('hot-path constants', () => {
  it('match @aoc/contracts (also enforced at compile time by `satisfies`)', () => {
    expect(PATHS).toEqual({ hook: INGEST_PATHS.hook, usage: INGEST_PATHS.usage, spool: INGEST_PATHS.spool });
    expect(ENV).toEqual({
      mode: AOC_ENV.mode,
      sessionId: AOC_ENV.sessionId,
      daemonUrl: AOC_ENV.daemonUrl,
      ingestToken: AOC_ENV.ingestToken,
      spoolDir: AOC_ENV.spoolDir,
    });
  });
});

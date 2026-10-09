import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { saveClientConfig } from '../config';
import type { CommandContext } from '../context';
import type { CliDeps } from '../deps';
import { UsageError } from '../errors';
import { defaultSettingsPath, installObservedHooks, uninstallObservedHooks } from '../observed-hooks';

/** Hook binary bundled next to the CLI by scripts/build.mjs. */
export const HOOK_BUNDLE = 'aoc-hook.mjs';

export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_/.:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function defaultHookCommand(
  deps: Pick<CliDeps, 'argv1' | 'execPath'>,
  exists: (p: string) => boolean = existsSync,
): string | null {
  if (!deps.argv1) return null;
  const bundled = join(dirname(resolve(deps.argv1)), HOOK_BUNDLE);
  return exists(bundled) ? `${shellQuote(deps.execPath)} ${shellQuote(bundled)}` : null;
}

interface InstallOpts {
  settings?: string;
  command?: string;
  observerToken?: string;
  json?: boolean;
}

export function registerHooks(program: Command, ctx: CommandContext): void {
  const hooks = program
    .command('hooks')
    .description('Claude Code hooks that make non-managed (observed) sessions visible');
  const settingsPath = (opt: string | undefined) =>
    opt ? ctx.resolvePath(opt) : defaultSettingsPath(ctx.deps.env, ctx.deps.homeDir);

  hooks
    .command('install-observed')
    .description(
      'register the AOC hook for every hook event in Claude Code settings (idempotent; keeps your hooks)',
    )
    .option(
      '--settings <file>',
      'settings file (default: ~/.claude/settings.json, honours CLAUDE_CONFIG_DIR)',
    )
    .option(
      '--command <cmd>',
      `hook command to register (default: node ${HOOK_BUNDLE} bundled next to this CLI)`,
    )
    .option(
      '--observer-token <token>',
      'observer token the hooks report with ("-" reads stdin); stored in ~/.aoc/client.json',
    )
    .option('--json', 'machine-readable output')
    .action(async (opts: InstallOpts, cmd: Command) => {
      const path = settingsPath(opts.settings);
      const command = opts.command?.trim() || defaultHookCommand(ctx.deps);
      if (!command)
        throw new UsageError(
          `cannot find the AOC hook binary (${HOOK_BUNDLE}) next to this CLI`,
          'pass --command "<hook command>"',
        );
      const observerToken = opts.observerToken
        ? await ctx.secret(opts.observerToken, 'observer token')
        : null;

      const r = installObservedHooks(path, command);
      const existing = ctx.config();
      if (observerToken)
        saveClientConfig(ctx.configPath, {
          ...existing,
          daemonUrl: ctx.target(cmd).daemonUrl,
          observerToken,
        });
      const hasObserverToken = !!(observerToken ?? existing?.observerToken);

      if (opts.json)
        return ctx.json({ settingsPath: path, command, ...r, observerTokenConfigured: hasObserverToken });
      ctx.print(
        r.changed
          ? `Installed AOC observed-session hooks for ${r.events} events in ${path}.`
          : `AOC observed-session hooks already installed in ${path}; nothing changed.`,
      );
      if (r.backupPath) ctx.print(`Previous settings backed up to ${r.backupPath}.`);
      ctx.print(`Hook command: ${command}`);
      if (observerToken) ctx.print(`Observer token stored in ${ctx.configPath} (0600).`);
      if (!hasObserverToken) {
        ctx.warn(
          'warning: no observer token configured — the hooks buffer locally until you add one with --observer-token <token>.',
        );
      }
    });

  hooks
    .command('uninstall')
    .description('remove the AOC observed-session hooks (other hooks are left untouched)')
    .option(
      '--settings <file>',
      'settings file (default: ~/.claude/settings.json, honours CLAUDE_CONFIG_DIR)',
    )
    .option('--json', 'machine-readable output')
    .action((opts: { settings?: string; json?: boolean }) => {
      const path = settingsPath(opts.settings);
      const r = uninstallObservedHooks(path);
      if (opts.json) return ctx.json({ settingsPath: path, ...r });
      ctx.print(
        r.removed > 0
          ? `Removed ${r.removed} AOC hook entries from ${path}.`
          : `No AOC hooks in ${path}; nothing changed.`,
      );
      if (r.backupPath) ctx.print(`Previous settings backed up to ${r.backupPath}.`);
    });
}

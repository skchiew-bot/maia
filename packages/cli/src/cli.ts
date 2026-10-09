import { Command, CommanderError } from 'commander';
import { AOC_ENV } from '@aoc/contracts';
import pkg from '../package.json' with { type: 'json' };
import { registerAudit } from './commands/audit';
import { registerAuth } from './commands/auth';
import { registerDecisions } from './commands/decisions';
import { registerDoctor } from './commands/doctor';
import { registerHooks } from './commands/hooks';
import { registerProjects } from './commands/projects';
import { registerRun } from './commands/run';
import { registerServe } from './commands/serve';
import { registerSessions } from './commands/sessions';
import { registerUsers } from './commands/users';
import { CommandContext } from './context';
import type { CliDeps } from './deps';
import { CliError, EXIT } from './errors';
import { oneLine } from './format';

export const VERSION: string = pkg.version;

/**
 * The CLI acts with a human's identity (approving decisions, issuing tokens). A managed session runs as the
 * same OS user and could otherwise borrow that identity through ~/.aoc/client.json — agents speak through
 * the AOC MCP tools instead. A speed bump, not the wall: credential isolation (§3) is the wall.
 */
function refuseInsideManagedSession(ctx: CommandContext): void {
  if (ctx.deps.env[AOC_ENV.sessionId]) {
    throw new CliError(
      `refusing to run inside a managed AOC session (${AOC_ENV.sessionId} is set)`,
      EXIT.AUTH,
      { hint: 'the aoc CLI acts for a person; agents use the AOC MCP tools' },
    );
  }
}

export function buildProgram(ctx: CommandContext): Command {
  const program = new Command('aoc')
    .description('AOC — Agent Ops Console: launch, watch and govern Claude Code sessions')
    .version(VERSION, '-V, --version')
    .option('--daemon <url>', 'daemon URL (else $AOC_DAEMON_URL, ~/.aoc/client.json, http://127.0.0.1:7420)')
    .option('--token <token>', 'API token (else $AOC_TOKEN, ~/.aoc/client.json)')
    .exitOverride()
    .configureOutput({ writeOut: (s) => ctx.deps.stdout(s), writeErr: (s) => ctx.deps.stderr(s) })
    .configureHelp({ showGlobalOptions: true })
    .showHelpAfterError('(run with --help for usage)')
    .addHelpText(
      'after',
      '\nExit codes: 0 ok · 1 error · 2 usage · 3 auth (not logged in, forbidden, passkey required)',
    )
    .hook('preAction', () => refuseInsideManagedSession(ctx));

  registerAuth(program, ctx);
  registerServe(program, ctx);
  registerRun(program, ctx);
  registerSessions(program, ctx);
  registerDecisions(program, ctx);
  registerProjects(program, ctx);
  registerAudit(program, ctx);
  registerUsers(program, ctx);
  registerHooks(program, ctx);
  registerDoctor(program, ctx);
  return program;
}

/** Run one CLI invocation; resolves to the process exit code (never calls process.exit). */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const ctx = new CommandContext(deps);
  try {
    await buildProgram(ctx).parseAsync(argv, { from: 'user' });
    return ctx.exitCode;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Commander has already printed the message or help text.
      return err.code === 'commander.helpDisplayed' || err.code === 'commander.version'
        ? EXIT.OK
        : EXIT.USAGE;
    }
    if (err instanceof CliError) {
      ctx.warn(`error: ${oneLine(err.message)}`);
      for (const line of err.extra.lines ?? []) ctx.warn(`  - ${oneLine(line)}`);
      if (err.extra.hint) ctx.warn(`hint: ${oneLine(err.extra.hint)}`);
      return err.exitCode;
    }
    ctx.warn(`error: ${oneLine(err instanceof Error ? err.message : String(err))}`);
    return EXIT.ERROR;
  }
}

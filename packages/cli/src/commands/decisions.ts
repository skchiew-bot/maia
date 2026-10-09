import type { Command } from 'commander';
import { requiresPasskey as kindRequiresPasskey, type DecisionCard } from '@aoc/contracts';
import { listOf, type CommandContext } from '../context';
import { CliError, EXIT, UsageError } from '../errors';
import { formatAge, oneLine, renderTable } from '../format';
import { ApiError, isRecord, type Api } from '../http';
import { API_PATHS, API_QUERY, CONSOLE_PATHS, withQuery } from '../paths';

export function oldestFirst(cards: DecisionCard[]): DecisionCard[] {
  return [...cards].sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0));
}

function optionsCell(c: DecisionCard): string {
  return (c.options ?? []).map((o) => (c.recommendation?.optionId === o.id ? `${o.id}*` : o.id)).join(' | ');
}

/** The card's flag, backed by the shared policy so a go-live/rollback/break-glass card is never treated as passkey-free. */
function needsPasskey(c: DecisionCard): boolean {
  return c.requiresPasskey === true || kindRequiresPasskey(c.kind);
}

function needsCell(c: DecisionCard): string {
  const who = `${c.requiredRole}${needsPasskey(c) ? ' + passkey' : ''}`;
  return c.viewer && !c.viewer.canResolve ? `${who} (not you)` : who;
}

export function renderDecisions(cards: DecisionCard[], now: number, all: boolean): string {
  if (cards.length === 0) return all ? 'No decisions.' : 'No open decisions — nothing is waiting on you.';
  const rows = oldestFirst(cards).map((c) => [
    c.id,
    formatAge(c.createdAt, now),
    ...(all ? [c.resolution ? `${c.status}: ${c.resolution.optionId}` : c.status] : []),
    c.test ? `${c.kind}/${c.test}` : c.kind,
    c.title,
    optionsCell(c),
    needsCell(c),
    c.sessionId ?? c.projectId ?? `${c.subjectType}:${c.subjectId}`,
  ]);
  return (
    renderTable(
      [
        { header: 'ID' },
        { header: 'AGE', align: 'right' },
        ...(all ? [{ header: 'STATUS', max: 24 }] : []),
        { header: 'KIND' },
        { header: 'TITLE', max: 48 },
        { header: 'OPTIONS (*recommended)', max: 40 },
        { header: 'NEEDS' },
        { header: 'FOR' },
      ],
      rows,
    ) + '\n\nAnswer with: aoc decide <id> --option <optionId> [--comment "<why>"]'
  );
}

/**
 * The open card from the inbox, or null when it is not there (already resolved, unknown, or the list is
 * unavailable) — the resolve call then has the final word.
 */
async function findOpenCard(api: Api, id: string): Promise<DecisionCard | null> {
  try {
    const path = withQuery(API_PATHS.decisions, { [API_QUERY.decisionsStatus]: 'open' });
    const cards = listOf<DecisionCard>(await api.get(path), 'decisions', 'decisions', 'items');
    const card = cards.find((c) => isRecord(c) && c.id === id);
    return card && Array.isArray(card.options) ? card : null;
  } catch (err) {
    if (err instanceof ApiError && (err.exitCode === EXIT.AUTH || err.status === null)) throw err;
    return null;
  }
}

function isPasskeyError(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    (err.status === 428 || /passkey|webauthn/i.test(`${err.code ?? ''} ${err.message}`))
  );
}

export function registerDecisions(program: Command, ctx: CommandContext): void {
  program
    .command('decisions')
    .description('decision inbox: open decisions, oldest first with age')
    .option('--all', 'include resolved, withdrawn and expired decisions')
    .option('--json', 'machine-readable output')
    .action(async (opts: { all?: boolean; json?: boolean }, cmd: Command) => {
      const path = opts.all
        ? API_PATHS.decisions
        : withQuery(API_PATHS.decisions, { [API_QUERY.decisionsStatus]: 'open' });
      let cards = listOf<DecisionCard>(await ctx.api(cmd).get(path), 'decisions', 'decisions', 'items');
      if (!opts.all) cards = cards.filter((c) => c.status === 'open');
      if (opts.json) return ctx.json(oldestFirst(cards));
      ctx.print(renderDecisions(cards, ctx.deps.now(), !!opts.all));
    });

  program
    .command('decide')
    .description('resolve a decision (passkey decisions must be approved in the console)')
    .argument('<decisionId>')
    .requiredOption('--option <optionId>', 'option to choose')
    .option('--comment <text>', 'why — recorded with the resolution')
    .option('--json', 'machine-readable output')
    .action(async (id: string, opts: { option: string; comment?: string; json?: boolean }, cmd: Command) => {
      const api = ctx.api(cmd);
      // A WebAuthn assertion needs a browser and an authenticator; the CLI never fakes or skips it.
      const passkeyExit = () => {
        ctx.warn(
          `Requires a passkey — approve in the console: ${ctx.consoleUrl(cmd, CONSOLE_PATHS.decision(id))}`,
        );
        ctx.exitCode = EXIT.AUTH;
      };
      const card = await findOpenCard(api, id);
      if (card) {
        if (card.viewer && !card.viewer.canResolve) {
          throw new CliError(
            `you cannot resolve ${id}: ${oneLine(card.viewer.reason) || 'not eligible'}`,
            EXIT.AUTH,
          );
        }
        if (needsPasskey(card)) return passkeyExit();
        if (!card.options.some((o) => o.id === opts.option)) {
          throw new UsageError(
            `"${opts.option}" is not an option of ${id}`,
            `options: ${card.options.map((o) => o.id).join(', ')}`,
          );
        }
      }
      let res: unknown;
      try {
        res = await api.post<unknown>(API_PATHS.decisionResolve(id), {
          optionId: opts.option,
          comment: opts.comment ?? null,
        });
      } catch (err) {
        if (isPasskeyError(err)) return passkeyExit();
        throw err;
      }
      if (opts.json) return ctx.json(res ?? { ok: true });
      const label = card?.options.find((o) => o.id === opts.option)?.label;
      ctx.print(`Resolved ${id} → ${opts.option}${label ? ` (${oneLine(label)})` : ''}.`);
    });
}

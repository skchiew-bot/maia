import { Option, type Command } from 'commander';
import {
  LIVENESS_STATES,
  SESSION_LIFECYCLE,
  type ConsoleSnapshot,
  type SessionDetail,
  type SessionLifecycle,
  type SessionSummary,
} from '@aoc/contracts';
import { listOf, objectOf, str, type CommandContext } from '../context';
import { CliError, EXIT } from '../errors';
import {
  formatAge,
  formatDuration,
  int,
  livenessBadge,
  livenessRank,
  modelCell,
  oneLine,
  pct,
  progressCell,
  renderKv,
  renderTable,
  tasksCell,
  usd,
} from '../format';
import { isRecord } from '../http';
import { API_PATHS, API_QUERY, CONSOLE_PATHS, withQuery } from '../paths';

const NOT_LIVE: readonly SessionLifecycle[] = ['ended', 'failed', 'retired'];
/** `--state` accepts a lifecycle, a liveness state, or the aliases below. */
export const STATE_ALIASES: Record<string, string> = { waiting: 'waiting_on_you', active: 'active' };
export const STATE_CHOICES = [
  ...new Set([...SESSION_LIFECYCLE, ...LIVENESS_STATES, ...Object.keys(STATE_ALIASES)]),
];

export function matchesState(s: SessionSummary, state: string): boolean {
  const want = STATE_ALIASES[state] ?? state;
  if (want === 'active') return !NOT_LIVE.includes(s.lifecycle);
  return s.lifecycle === want || s.liveness?.state === want;
}

export function sortByAttention<T extends Pick<SessionSummary, 'liveness'>>(rows: T[]): T[] {
  return rows
    .map((s, i) => ({ s, i }))
    .sort((a, b) => livenessRank(a.s.liveness?.state) - livenessRank(b.s.liveness?.state) || a.i - b.i)
    .map((x) => x.s);
}

function projectPhase(s: SessionSummary): string {
  const project = s.projectName ?? s.projectId;
  const phase = s.phaseName ?? s.phaseId;
  if (!project) return '—';
  return phase ? `${project}·${phase}` : project;
}

function typeModel(s: SessionSummary): string {
  return `${s.processType ?? (s.mode === 'observed' ? 'observed' : '—')}/${modelCell(s.model)}`;
}

export function renderConsole(snap: ConsoleSnapshot, fallbackNow: number): string {
  const now = Date.parse(snap.generatedAt) || fallbackNow;
  const k = snap.kpis;
  const oldest = k.oldestWaitingSince ? ` (oldest ${formatAge(k.oldestWaitingSince, now)})` : '';
  const rm = typeof k.notionalRmToday === 'number' ? ` / RM ${k.notionalRmToday.toFixed(2)}` : '';
  const kpi = [
    `${k.activeSessions} active`,
    `${k.waitingOnYou} waiting on you${oldest}`,
    `${k.throttled} throttled (${formatDuration(k.throttleIdleMsToday)} idle today)`,
    `${k.tasksDoneToday} tasks done today (${pct(k.tasksDoneWithEvidencePct)} with evidence)`,
    `notional API-equivalent ${usd(k.notionalUsdToday)}${rm} today`,
  ].join(' · ');
  if (snap.sessions.length === 0) return `${kpi}\n\nNo sessions.`;
  const rows = sortByAttention(snap.sessions).map((s) => [
    s.sessionId,
    s.title || s.sessionId,
    projectPhase(s),
    typeModel(s),
    livenessBadge(s.liveness?.state, s.lifecycle),
    tasksCell(s.progress),
    pct(s.contextPct),
    s.openDecision ? formatAge(s.openDecision.createdAt, now) : '—',
  ]);
  const table = renderTable(
    [
      { header: 'ID' },
      { header: 'NAME', max: 32 },
      { header: 'PROJECT·PHASE', max: 32 },
      { header: 'TYPE/MODEL', max: 28 },
      { header: 'LIVENESS' },
      { header: 'TASKS', align: 'right' },
      { header: 'CTX', align: 'right' },
      { header: 'DECISION', align: 'right' },
    ],
    rows,
  );
  return `${kpi}\n\n${table}`;
}

export function renderSessionList(sessions: SessionSummary[], now: number): string {
  if (sessions.length === 0) return 'No sessions match.';
  return renderTable(
    [
      { header: 'ID' },
      { header: 'NAME', max: 32 },
      { header: 'PROJECT·PHASE', max: 32 },
      { header: 'TYPE/MODEL', max: 28 },
      { header: 'LIFECYCLE' },
      { header: 'LIVENESS' },
      { header: 'TASKS', align: 'right' },
      { header: 'STARTED', align: 'right' },
    ],
    sessions.map((s) => [
      s.sessionId,
      s.title || s.sessionId,
      projectPhase(s),
      typeModel(s),
      s.lifecycle,
      livenessBadge(s.liveness?.state, s.lifecycle),
      tasksCell(s.progress),
      `${formatAge(s.startedAt, now)} ago`,
    ]),
  );
}

export function renderSessionDetail(s: SessionDetail, now: number, consoleUrl: string): string {
  const p = s.progress;
  const eta = !p
    ? undefined
    : p.etaMs !== null
      ? formatDuration(p.etaMs)
      : p.etaHiddenReason === 'complete'
        ? 'complete'
        : 'hidden until 3 tasks are done';
  const liveness = s.liveness
    ? `${livenessBadge(s.liveness.state, s.lifecycle)} — ${s.liveness.reason}, since ${formatAge(s.liveness.since, now)}`
    : livenessBadge(null, s.lifecycle);
  const ctxLine =
    s.contextTokens === null
      ? '—'
      : `${int(s.contextTokens)}${s.contextWindowTokens ? ` / ${int(s.contextWindowTokens)}` : ''} tokens (${pct(s.contextPct)})`;
  const head = renderKv([
    ['Session', `${s.sessionId} (${s.mode}${s.readOnly ? ', read-only' : ''})`],
    ['Title', s.title],
    ['Project', s.projectId ? `${s.projectName ?? s.projectId} (${s.projectId})` : '—'],
    ['Phase', s.phaseId ? `${s.phaseName ?? s.phaseId} (${s.phaseId})` : '—'],
    ['Thread', s.threadId],
    ['Type/model', `${s.processType ?? '—'} / ${s.model ?? '—'}`],
    ['Owner', s.ownerId ? `${s.ownerName ?? s.ownerId} (${s.ownerId})` : '—'],
    ['Lifecycle', s.lifecycle],
    ['Liveness', liveness],
    [
      'Progress',
      p
        ? `${progressCell(p)} · ${p.doneTasks}/${p.totalTasks} tasks${p.flaggedTasks ? ` · ${p.flaggedTasks} flagged` : ''}`
        : 'no plan declared',
    ],
    ['ETA', eta],
    ['Context', ctxLine],
    ['Cost today', `${usd(s.costTodayUsd)} notional (API-equivalent, not a bill)`],
    [
      'Decision',
      s.openDecision
        ? `${s.openDecision.decisionId} (${s.openDecision.kind}), open ${formatAge(s.openDecision.createdAt, now)}`
        : 'none open',
    ],
    ['Throttled', s.throttledUntil ? `until ${s.throttledUntil}` : undefined],
    ['Started', `${s.startedAt} (${formatAge(s.startedAt, now)} ago)`],
    ['Turns', s.turns],
    ['Cwd', s.cwd],
    ['Ticket', s.ticketId ?? undefined],
    ['Rolled from', s.predecessorSessionId ?? undefined],
    ['Rolled into', s.successorSessionId ?? undefined],
    ['Console', consoleUrl],
  ]);
  const parts = [head];
  if (s.tokens?.length) {
    parts.push(
      'Tokens',
      renderTable(
        [
          { header: 'MODEL' },
          { header: 'INPUT', align: 'right' },
          { header: 'OUTPUT', align: 'right' },
          { header: 'CACHE READ', align: 'right' },
          { header: 'CACHE WRITE', align: 'right' },
          { header: 'NOTIONAL', align: 'right' },
        ],
        s.tokens.map((t) => [
          t.model,
          int(t.inputTokens),
          int(t.outputTokens),
          int(t.cacheReadTokens),
          int(t.cacheWriteTokens),
          usd(t.notionalUsd),
        ]),
      ),
    );
  }
  if (s.actions) {
    parts.push(
      'Actions',
      renderTable(
        [{ header: 'ACTION' }, { header: 'ALLOWED' }],
        Object.entries(s.actions).map(([name, a]) => [
          name,
          a.enabled ? 'yes' : `no — ${oneLine(a.reason) || 'not allowed'}`,
        ]),
      ),
    );
  }
  return parts.join('\n\n');
}

export function registerSessions(program: Command, ctx: CommandContext): void {
  program
    .command('status')
    .description('console overview: KPIs and one row per session (attention first)')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }, cmd: Command) => {
      const snap = await ctx.api(cmd).get<ConsoleSnapshot>(API_PATHS.console);
      if (opts.json) return ctx.json(snap);
      if (!isRecord(snap) || !isRecord(snap.kpis) || !Array.isArray(snap.sessions))
        throw new CliError('unexpected response from GET /api/console');
      ctx.print(renderConsole(snap, ctx.deps.now()));
    });

  program
    .command('sessions')
    .description('list sessions')
    .option('--project <projectId>', 'only this project')
    .addOption(
      new Option(
        '--state <state>',
        'lifecycle or liveness state (waiting = waiting_on_you, active = not ended)',
      ).choices(STATE_CHOICES),
    )
    .option('--json', 'machine-readable output')
    .action(async (opts: { project?: string; state?: string; json?: boolean }, cmd: Command) => {
      const path = withQuery(API_PATHS.sessions, {
        [API_QUERY.sessionsProject]: opts.project,
        [API_QUERY.sessionsState]: opts.state,
      });
      let sessions = listOf<SessionSummary>(await ctx.api(cmd).get(path), 'sessions', 'sessions', 'items');
      // Filter locally too, so the output is right even if the daemon ignores a parameter.
      if (opts.project) sessions = sessions.filter((s) => s.projectId === opts.project);
      if (opts.state) sessions = sessions.filter((s) => matchesState(s, opts.state!));
      if (opts.json) return ctx.json(sessions);
      ctx.print(renderSessionList(sessions, ctx.deps.now()));
    });

  program
    .command('session')
    .description('show one session in detail')
    .argument('<sessionId>')
    .option('--json', 'machine-readable output')
    .action(async (id: string, opts: { json?: boolean }, cmd: Command) => {
      const detail = objectOf<SessionDetail>(
        await ctx.api(cmd).get(API_PATHS.session(id)),
        'session',
        'session',
      );
      if (opts.json) return ctx.json(detail);
      ctx.print(
        renderSessionDetail(
          detail,
          ctx.deps.now(),
          ctx.consoleUrl(cmd, CONSOLE_PATHS.session(detail.sessionId ?? id)),
        ),
      );
    });

  const textAction =
    (path: (id: string) => string, verb: string, note: string) =>
    async (id: string, words: string[], opts: { json?: boolean }, cmd: Command) => {
      const text = await ctx.text(words, 'text');
      const res = await ctx.api(cmd).post<unknown>(path(id), { text });
      if (opts.json) return ctx.json(res ?? { ok: true });
      ctx.print(`${verb} ${id}: ${note}`);
    };

  program
    .command('prompt')
    .description('send an operator prompt to a session (resumes it if its turn ended)')
    .argument('<sessionId>')
    .argument('<text...>', 'prompt text ("-" reads stdin)')
    .option('--json', 'machine-readable output')
    .action(
      textAction(API_PATHS.sessionPrompt, 'Prompted', 'the supervisor delivers your text on the next turn.'),
    );

  program
    .command('nudge')
    .description('end the current turn and resume with your text')
    .argument('<sessionId>')
    .argument('<text...>', 'nudge text ("-" reads stdin)')
    .option('--json', 'machine-readable output')
    .action(
      textAction(API_PATHS.sessionNudge, 'Nudged', 'the current turn ends and resumes with your text.'),
    );

  program
    .command('restart')
    .description('restart a dead or stalled session (resumes from its transcript)')
    .argument('<sessionId>')
    .option('--json', 'machine-readable output')
    .action(async (id: string, opts: { json?: boolean }, cmd: Command) => {
      const res = await ctx.api(cmd, 30_000).post<unknown>(API_PATHS.sessionRestart(id), {});
      if (opts.json) return ctx.json(res ?? { ok: true });
      ctx.print(`Restart requested for ${id}.`);
    });

  program
    .command('stop')
    .description('stop a session at its next task boundary (--now: immediately)')
    .argument('<sessionId>')
    .option('--now', 'stop immediately instead of at the next task boundary')
    .option('--reason <text>', 'reason recorded with the stop')
    .option('--json', 'machine-readable output')
    .action(async (id: string, opts: { now?: boolean; reason?: string; json?: boolean }, cmd: Command) => {
      const res = await ctx
        .api(cmd)
        .post<unknown>(API_PATHS.sessionStop(id), { immediate: !!opts.now, reason: opts.reason });
      if (opts.json) return ctx.json(res ?? { ok: true });
      ctx.print(
        opts.now ? `Stopping ${id} now.` : `Stop requested for ${id}: it stops at its next task boundary.`,
      );
    });

  program
    .command('rollover')
    .description(
      'roll a thread over to a fresh session seeded with a handoff brief (clean task boundary only)',
    )
    .argument('<threadId>')
    .option('--json', 'machine-readable output')
    .action(async (threadId: string, opts: { json?: boolean }, cmd: Command) => {
      const res = await ctx.api(cmd, 60_000).post<unknown>(API_PATHS.threadRollover(threadId), {});
      if (opts.json) {
        ctx.json(res);
        if (isRecord(res) && Array.isArray(res.refused)) ctx.exitCode = EXIT.ERROR;
        return;
      }
      if (isRecord(res) && Array.isArray(res.refused)) {
        throw new CliError(`rollover of ${threadId} refused`, EXIT.ERROR, {
          lines: res.refused.map((r) => oneLine(r)),
        });
      }
      const next = isRecord(res) ? (str(res.newSessionId) ?? str(res.sessionId)) : null;
      ctx.print(
        next
          ? `Rolled over ${threadId} → ${next} (${ctx.consoleUrl(cmd, CONSOLE_PATHS.session(next))})`
          : `Rollover of ${threadId} requested.`,
      );
    });
}

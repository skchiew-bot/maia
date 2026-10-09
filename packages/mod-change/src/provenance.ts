/**
 * Provenance guarantee (§14): no orphan commits to main. A commit is traced when its message carries an
 * `AOC-Session: <id>` or `AOC-Change: <id>` trailer that leads to a gate — an approved change record (the session
 * was linked to it by change.started) or a ticket whose fix plan was approved. Everything else is an orphan.
 */
import type { ProvenanceCommitDTO } from '@aoc/contracts';

export interface LoggedCommit {
  sha: string;
  subject: string;
  message: string;
}

/** `git log` format consumed by parseLog: sha, subject, raw message. */
export const LOG_FORMAT = '--format=%H%x1f%s%x1f%B%x1e';

export function parseLog(stdout: string): LoggedCommit[] {
  return stdout
    .split('\x1e')
    .map((r) => r.replace(/^\n+/, ''))
    .filter((r) => r.trim())
    .map((r) => {
      const [sha, subject, message] = r.split('\x1f');
      return { sha: sha!.trim(), subject: subject ?? '', message: message ?? '' };
    });
}

const TRAILER = /^AOC-(Session|Change):[ \t]*([A-Za-z0-9_.:-]{1,64})[ \t]*$/gim;

export function parseTrailers(message: string): { sessionIds: string[]; changeIds: string[] } {
  const sessionIds = new Set<string>();
  const changeIds = new Set<string>();
  for (const m of message.matchAll(TRAILER))
    (m[1]!.toLowerCase() === 'session' ? sessionIds : changeIds).add(m[2]!);
  return { sessionIds: [...sessionIds], changeIds: [...changeIds] };
}

export interface ProvenanceLookups {
  /** Change is approved (approved / in progress / completed) and belongs to the project. */
  changeApproved(changeId: string, projectId: string): boolean;
  /** An approved change of the project that the session was linked to via change.started, if any. */
  sessionChange(sessionId: string, projectId: string): string | null;
  sessionTicket(sessionId: string): string | null;
  ticketFixPlanApproved(ticketId: string): boolean;
}

export function classifyCommit(
  c: LoggedCommit,
  projectId: string,
  look: ProvenanceLookups,
): ProvenanceCommitDTO {
  const { sessionIds, changeIds } = parseTrailers(c.message);
  const base = { sha: c.sha, subject: c.subject, sessionIds, changeIds };
  if (!sessionIds.length && !changeIds.length) {
    return {
      ...base,
      ticketIds: [],
      traced: false,
      via: null,
      reason: 'no AOC-Session / AOC-Change trailer',
    };
  }
  const approvedChange = changeIds.find((id) => look.changeApproved(id, projectId));
  if (approvedChange) return { ...base, ticketIds: [], traced: true, via: 'change', reason: null };
  const ticketIds: string[] = [];
  for (const s of sessionIds) {
    if (look.sessionChange(s, projectId))
      return { ...base, ticketIds, traced: true, via: 'session_change', reason: null };
    const ticket = look.sessionTicket(s);
    if (ticket) {
      ticketIds.push(ticket);
      if (look.ticketFixPlanApproved(ticket))
        return { ...base, ticketIds, traced: true, via: 'session_ticket', reason: null };
    }
  }
  const named = [...changeIds.map((id) => `change ${id}`), ...sessionIds.map((id) => `session ${id}`)].join(
    ', ',
  );
  return {
    ...base,
    ticketIds,
    traced: false,
    via: null,
    reason: `${named}: no approved change record or approved fix plan`,
  };
}

/**
 * Provenance guarantee (§14): no orphan commits to main. Commit trailers are written by the agent, so a trailer alone
 * proves nothing. A commit is traced only when
 *  (a) an `AOC-Session: <id>` trailer names a session the platform itself linked to a gate — an approved change record
 *      (change.started, inherited on rollover) or a ticket whose fix plan was approved — and every `AOC-Change`
 *      trailer names one of that session's approved changes, and
 *  (b) the commit is reachable from a HEAD the ledger recorded for that session (task.done headSha,
 *      phase.completed pinnedSha), i.e. it really was in that session's working history.
 * Everything else is an orphan.
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
  /** Approved changes of the project the session was linked to (change.started, inherited on rollover). */
  sessionChanges(sessionId: string, projectId: string): string[];
  /** The ticket the session was launched or built for (supervisor / intake records, never a trailer). */
  sessionTicket(sessionId: string): string | null;
  ticketFixPlanApproved(ticketId: string): boolean;
  /** The commit is reachable from a HEAD the ledger recorded for the session (task.done, phase.completed). */
  sessionRecorded(sessionId: string, sha: string): boolean;
}

type Via = NonNullable<ProvenanceCommitDTO['via']>;

export function classifyCommit(
  c: LoggedCommit,
  projectId: string,
  look: ProvenanceLookups,
): ProvenanceCommitDTO {
  const { sessionIds, changeIds } = parseTrailers(c.message);
  const base = { sha: c.sha, subject: c.subject, sessionIds, changeIds };
  const orphan = (ticketIds: string[], reason: string): ProvenanceCommitDTO => ({
    ...base,
    ticketIds,
    traced: false,
    via: null,
    reason,
  });
  if (!sessionIds.length && !changeIds.length) return orphan([], 'no AOC-Session / AOC-Change trailer');
  if (!sessionIds.length)
    return orphan(
      [],
      `${changeIds.map((id) => `change ${id}`).join(', ')}: an AOC-Change trailer alone is self-asserted; no AOC-Session links the commit to it`,
    );
  const ticketIds: string[] = [];
  const problems: string[] = [];
  for (const s of sessionIds) {
    const linked = look.sessionChanges(s, projectId);
    const ticket = look.sessionTicket(s);
    if (ticket) ticketIds.push(ticket);
    const unlinked = changeIds.filter((id) => !linked.includes(id));
    if (unlinked.length) {
      problems.push(`session ${s} is not linked to approved change ${unlinked.join(', ')}`);
      continue;
    }
    const via: Via | null = changeIds.length
      ? 'change'
      : linked.length
        ? 'session_change'
        : ticket && look.ticketFixPlanApproved(ticket)
          ? 'session_ticket'
          : null;
    if (!via) {
      problems.push(`session ${s}: no approved change record or approved fix plan`);
      continue;
    }
    if (!look.sessionRecorded(s, c.sha)) {
      problems.push(`session ${s} never recorded a HEAD containing this commit (task_done / phase pin)`);
      continue;
    }
    return { ...base, ticketIds, traced: true, via, reason: null };
  }
  return orphan(ticketIds, problems.join('; '));
}

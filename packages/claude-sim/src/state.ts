import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ScenarioRef } from './scenario';
import type { ContextState } from './usage';

/** Per-session simulator state ($CLAUDE_CONFIG_DIR/sim-state/<session-id>.json). */
export interface SimState {
  version: 1;
  sessionId: string;
  scenario: ScenarioRef;
  /** Index of the next scenario step. */
  cursor: number;
  /** Values captured by `saveAs`, available to `{{name.path}}` templates. */
  saved: Record<string, unknown>;
  context: ContextState;
  /** Position of the deterministic id source, so ids never repeat across resumes. */
  idCounter: number;
  turns: number;
  createdAt: string;
  updatedAt: string;
}

const SimStateSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  scenario: z.union([
    z.object({ kind: z.literal('builtin'), name: z.string() }),
    z.object({ kind: z.literal('file'), path: z.string() }),
  ]),
  cursor: z.number().int().nonnegative(),
  saved: z.record(z.unknown()),
  context: z.object({
    cachedPrefix: z.number().nonnegative(),
    uncached: z.number().nonnegative(),
    lastRequestAt: z.number().nullable(),
  }),
  idCounter: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** The stored state, or null when missing or unreadable (a resume then starts the scenario over). */
export function loadState(file: string): SimState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const parsed = SimStateSchema.safeParse(raw);
  return parsed.success ? (parsed.data as SimState) : null;
}

/** Atomic write (temp file + rename) so a crash or kill never leaves a torn state file. */
export function saveState(file: string, state: SimState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(temp, file);
}

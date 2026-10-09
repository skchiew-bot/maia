const installed = Symbol.for('aoc.sqliteWarningFilter');

/**
 * Drop node:sqlite's "SQLite is an experimental feature" ExperimentalWarning; every other warning
 * still prints. Node emits it when node:sqlite is first loaded, so this must run before the module
 * graph that imports it is loaded (main.ts imports the daemon dynamically for that reason).
 */
export function suppressSqliteExperimentalWarning(): void {
  const proc = process as NodeJS.Process & { [installed]?: true };
  if (proc[installed]) return;
  proc[installed] = true;
  const emit = process.emitWarning.bind(process) as (warning: string | Error, ...rest: unknown[]) => void;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const opt = rest[0];
    const type =
      typeof opt === 'string'
        ? opt
        : ((opt as { type?: string } | undefined)?.type ??
          (warning instanceof Error ? warning.name : undefined));
    const message = typeof warning === 'string' ? warning : warning.message;
    if (type === 'ExperimentalWarning' && /\bSQLite\b/.test(message)) return;
    emit(warning, ...rest);
  }) as typeof process.emitWarning;
}

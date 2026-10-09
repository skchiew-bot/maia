/** Exit codes (stable contract for scripts): 0 ok, 1 error, 2 usage, 3 auth. */
export const EXIT = { OK: 0, ERROR: 1, USAGE: 2, AUTH: 3 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.ERROR,
    readonly extra: { hint?: string; lines?: string[] } = {},
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export class UsageError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, EXIT.USAGE, { hint });
    this.name = 'UsageError';
  }
}

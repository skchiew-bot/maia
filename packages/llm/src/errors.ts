/** Typed LLM failures. Callers decide per type: unavailable → retry/escalate later; output invalid → never use the data. */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly code: 'llm_unavailable' | 'llm_output_invalid',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The model could not be reached or did not complete: spawn/network failure, timeout, auth, rate limit, API or CLI error. */
export class LlmUnavailableError extends LlmError {
  constructor(
    message: string,
    readonly status: number | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, 'llm_unavailable', options);
  }
}

/** The model answered but the output is unusable: not JSON, fails the schema, truncated, or refused. */
export class LlmOutputInvalidError extends LlmError {
  constructor(
    message: string,
    readonly problems: string[],
    readonly raw: string,
  ) {
    super(message, 'llm_output_invalid');
  }
}

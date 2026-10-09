import type { OutputFormat } from './args';

export interface Writer {
  write(chunk: string): unknown;
}

export type StreamMessage = { type: string } & Record<string, unknown>;

/**
 * stdout in the three print-mode formats: `text` prints the final result, `json` one result object (or,
 * with --verbose, an array of every message like the real CLI), `stream-json` one JSON message per line.
 */
export class OutputSink {
  private readonly collected: StreamMessage[] = [];

  constructor(
    private readonly format: OutputFormat,
    private readonly verbose: boolean,
    private readonly includePartial: boolean,
    private readonly stdout: Writer,
  ) {}

  get partialsEnabled(): boolean {
    return this.format === 'stream-json' && this.includePartial;
  }

  emit(message: StreamMessage): void {
    if (this.format === 'stream-json') this.stdout.write(`${JSON.stringify(message)}\n`);
    else if (this.format === 'json' && this.verbose) this.collected.push(message);
  }

  result(message: StreamMessage, stderr: Writer): void {
    if (this.format === 'stream-json') {
      this.stdout.write(`${JSON.stringify(message)}\n`);
      return;
    }
    if (this.format === 'json') {
      this.stdout.write(`${JSON.stringify(this.verbose ? [...this.collected, message] : message)}\n`);
      return;
    }
    if (typeof message.result === 'string') this.stdout.write(`${message.result}\n`);
    else if (Array.isArray(message.errors)) stderr.write(`${message.errors.join('\n')}\n`);
  }
}

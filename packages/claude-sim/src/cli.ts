import { runClaudeSim } from './run';

/** Wait until everything written so far has been handed to the OS (pipes are async on POSIX). */
function drain(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => stream.write('', () => resolve()));
}

const controller = new AbortController();
let signals = 0;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    signals += 1;
    // A second signal means "now": skip the graceful SessionEnd / MCP shutdown.
    if (signals > 1) process.exit(signal === 'SIGINT' ? 130 : 143);
    controller.abort(signal);
  });
}
// The reader went away (e.g. the supervisor died): stop like a process killed by SIGPIPE.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EPIPE') throw error;
  process.exit(141);
});

runClaudeSim(process.argv.slice(2), process.env, {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  signal: controller.signal,
})
  .then(async (code) => {
    await drain(process.stdout);
    await drain(process.stderr);
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    process.stderr.write(
      `claude-sim: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    await drain(process.stderr);
    process.exit(1);
  });

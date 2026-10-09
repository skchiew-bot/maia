import { suppressSqliteExperimentalWarning } from './warnings';

// The filter has to be in place before node:sqlite loads, so everything else is imported dynamically.
suppressSqliteExperimentalWarning();
const { runDaemon } = await import('./daemon');
await runDaemon();

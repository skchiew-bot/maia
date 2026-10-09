#!/usr/bin/env node
// Runs the TypeScript entry through tsx (a root devDependency) so the sim can be spawned without a build.
// The package's own tsconfig is pinned so a tsconfig.json in the session's working directory cannot leak in.
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

register({ tsconfig: fileURLToPath(new URL('../tsconfig.json', import.meta.url)) });
await import('../src/cli.ts');

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/**
 * probe.ts as a browser script that defines `window.__aocProbe`. Bundled with esbuild rather than passing
 * functions to page.evaluate: tsx would inject its `__name` helper into serialised functions.
 */
export async function bundleProbe(): Promise<string> {
  const result = await build({
    entryPoints: [join(dirname(fileURLToPath(import.meta.url)), 'probe.ts')],
    bundle: true,
    format: 'iife',
    globalName: '__aocProbe',
    // page.evaluate runs the bundle in a scope where `var` does not become a global.
    footer: { js: 'window.__aocProbe = __aocProbe;' },
    target: 'chrome120',
    write: false,
    logLevel: 'silent',
  });
  return result.outputFiles[0]!.text;
}

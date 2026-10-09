import { describe, expect, it } from 'vitest';
import { createDefaultModules } from '../src/modules';

const modules = createDefaultModules();
const mod = (name: string) => {
  const m = modules.find((x) => x.name === name);
  if (!m) throw new Error(`no module ${name}`);
  return m;
};

describe('production composition: structural guarantees', () => {
  it('a prompt can never turn into progress: no reactor reacts to prompt.submitted, the ledger never projects it (§1)', () => {
    for (const m of modules)
      for (const r of m.reactors ?? [])
        expect(r.handles, `${m.name}/${r.name}`).not.toContain('prompt.submitted');
    for (const p of mod('ledger').projectors ?? []) {
      expect(p.handles, p.name).toBeDefined();
      expect(p.handles, p.name).not.toContain('prompt.submitted');
    }
  });

  it('metering and credits never stop work mid-task: neither registers a PreToolUse guard (§10, R7)', () => {
    expect(mod('metering').guards ?? []).toEqual([]);
    expect(mod('metering').reactors ?? []).toEqual([]);
    expect(mod('credits').guards ?? []).toEqual([]);
  });
});

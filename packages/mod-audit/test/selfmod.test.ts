import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PROTECTED_PATHS, type SessionInfo, type SessionMode } from '@aoc/contracts';
import { sha256hex } from '@aoc/kernel';
import { BoundaryMatcher, verifyExternalAuditLog } from '../src';
import { auditRuntime, type AuditTest } from './helpers';

const FILES = [
  'packages/kernel/src/store.ts',
  'packages/mod-tower/src/tower.ts',
  'packages/mod-audit/src/index.ts',
  'config/rate-card.json',
  'CLAUDE.md',
];
const KERNEL_PATCH = [
  'diff --git a/packages/kernel/src/store.ts b/packages/kernel/src/store.ts',
  '--- a/packages/kernel/src/store.ts',
  '+++ b/packages/kernel/src/store.ts',
  '@@ -1 +1 @@',
  '-// x',
  '+// y',
  '',
].join('\n');

let base: string;
let root: string; // the AOC repo
let other: string; // a customer repo with the same layout
let a: AuditTest;
let session: SessionInfo;

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'aoc-selfmod-')));
  root = join(base, 'maia');
  other = join(base, 'other');
  for (const r of [root, other]) {
    for (const f of FILES) {
      mkdirSync(dirname(join(r, f)), { recursive: true });
      writeFileSync(join(r, f), '// x\n');
    }
  }
  writeFileSync(join(root, 'fix.patch'), KERNEL_PATCH);
  writeFileSync(
    join(root, 'ledger.patch'),
    KERNEL_PATCH.replaceAll('packages/kernel/src/store.ts', 'packages/mod-tower/src/tower.ts'),
  );
  a = await auditRuntime({ config: { selfModification: { aocRepoPaths: [root] } } });
  session = a.t.sessions!.add({ sessionId: 'ses_agent1', mode: 'managed', cwd: root, projectId: 'prj_aoc' });
});

afterAll(async () => {
  await a.t.close();
  rmSync(base, { recursive: true, force: true });
});

function pre(
  toolName: string,
  toolInput: Record<string, unknown>,
  o: { cwd?: string; mode?: SessionMode } = {},
) {
  const mode = o.mode ?? 'managed';
  return a.t.rt.policy.evaluate({
    session: { ...session, mode },
    mode,
    toolName,
    toolInput,
    cwd: o.cwd ?? root,
  });
}
const bash = (command: string, cwd?: string) => pre('Bash', { command }, { cwd });

describe('self-modification guard: file tools', () => {
  it('is registered as the first PreToolUse guard', () => {
    expect(a.t.rt.policy.list()[0]).toBe('self-modification');
  });

  it('denies Edit/Write/MultiEdit/NotebookEdit into the protected core, records the attempt in the chain and outside AOC', () => {
    const before = a.t.rt.store.head().seq;
    const target = join(root, 'packages/kernel/src/store.ts');
    const r = pre('Edit', { file_path: target, old_string: 'x', new_string: 'y' });
    expect(r).toMatchObject({
      decision: 'deny',
      guard: 'self-modification',
      blockReason: 'self_modification',
    });
    expect(r.reason).toMatch(
      /packages\/kernel\/src\/store\.ts is part of AOC's governance\/audit\/credit core \(packages\/kernel\/\)/,
    );
    expect(r.raiseDecision).toBeUndefined();

    const [e] = a.t.rt.store.list({ fromSeq: before + 1, types: ['selfmod.blocked'] });
    expect(e!.meta).toEqual({
      sessionId: 'ses_agent1',
      rule: 'core.edit',
      pathHash: sha256hex(target),
      externalLogged: true,
    });
    expect(e!.scope).toEqual({ sessionId: 'ses_agent1', projectId: 'prj_aoc' });
    expect(a.t.rt.store.readPayload(e!)).toEqual({ path: 'packages/kernel/src/store.ts', toolName: 'Edit' });

    const lines = readFileSync(a.t.config.selfModification.externalAuditLog, 'utf8').trim().split('\n');
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({
      v: 1,
      kind: 'selfmod.blocked',
      chainId: a.t.rt.store.chainId,
      sessionId: 'ses_agent1',
      projectId: 'prj_aoc',
      toolName: 'Edit',
      rule: 'core.edit',
      path: 'packages/kernel/src/store.ts',
      root,
      pathHash: sha256hex(target),
      inputHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    expect(pre('Write', { file_path: 'config/new.json', content: '{}' })).toMatchObject({ decision: 'deny' });
    expect(
      pre('MultiEdit', { file_path: join(root, 'packages/mod-audit/src/index.ts'), edits: [] }),
    ).toMatchObject({ decision: 'deny' });
    expect(
      pre('NotebookEdit', { notebook_path: join(root, 'packages/kernel/nb.ipynb'), new_source: '' }),
    ).toMatchObject({ decision: 'deny' });
    expect(
      pre('mcp__fs__write_file', { path: join(root, 'packages/kernel/src/x.ts'), content: '' }),
    ).toMatchObject({ decision: 'deny' });
  });

  it('chains the external log lines so edits or truncation in the middle are evident', () => {
    pre('Edit', { file_path: join(root, 'config/rate-card.json') });
    const text = readFileSync(a.t.config.selfModification.externalAuditLog, 'utf8');
    expect(verifyExternalAuditLog(text)).toBeNull();
    const lines = text.trim().split('\n');
    expect(lines.length).toBeGreaterThan(1);
    expect(JSON.parse(lines[1]!).prev).toBe(sha256hex(lines[0]!));
    expect(
      verifyExternalAuditLog([lines[0], lines[2] ?? lines[1]!.replace('core.edit', 'core.xxxx')].join('\n')),
    ).toBe(1);
  });

  it('allows the platform to build its own features and leaves other repos alone', () => {
    expect(pre('Edit', { file_path: join(root, 'packages/mod-tower/src/tower.ts') })).toMatchObject({
      decision: 'allow',
    });
    expect(pre('Write', { file_path: join(root, 'docs/notes.md') })).toMatchObject({ decision: 'allow' });
    expect(pre('Read', { file_path: join(root, 'packages/kernel/src/store.ts') })).toMatchObject({
      decision: 'allow',
    });
    expect(
      pre('Edit', { file_path: join(other, 'packages/kernel/src/store.ts') }, { cwd: other }),
    ).toMatchObject({ decision: 'allow' });
    expect(pre('Write', { file_path: 'config/rate-card.json' }, { cwd: other })).toMatchObject({
      decision: 'allow',
    });
    expect(
      pre('Edit', { file_path: join(root, 'packages/kernel/src/store.ts') }, { mode: 'observed' }),
    ).toMatchObject({ decision: 'allow' });
  });

  it('is path-normalised: `..` traversal both ways, absolute paths from other repos', () => {
    expect(
      pre('Edit', { file_path: join(root, 'packages/mod-tower/../kernel/src/store.ts') }),
    ).toMatchObject({ decision: 'deny' });
    expect(
      pre('Edit', { file_path: 'packages/mod-tower/../../../maia/packages/kernel/src/store.ts' }),
    ).toMatchObject({ decision: 'deny' });
    expect(pre('Write', { file_path: './packages//kernel/./src/new.ts' })).toMatchObject({
      decision: 'deny',
    });
    expect(
      pre('Edit', { file_path: join(root, 'packages/kernel/../mod-tower/src/tower.ts') }),
    ).toMatchObject({ decision: 'allow' });
    expect(
      pre('Edit', { file_path: join(root, 'packages/kernel/src/store.ts') }, { cwd: other }),
    ).toMatchObject({ decision: 'deny' });
  });

  it('is symlink-safe: links into the core (also dangling ones and links from outside), and hard links', () => {
    symlinkSync('../kernel', join(root, 'packages/mod-tower/k'));
    expect(pre('Edit', { file_path: join(root, 'packages/mod-tower/k/src/store.ts') })).toMatchObject({
      decision: 'deny',
    });
    symlinkSync('../../kernel/src/new.ts', join(root, 'packages/mod-tower/src/evil.ts'));
    expect(pre('Write', { file_path: join(root, 'packages/mod-tower/src/evil.ts') })).toMatchObject({
      decision: 'deny',
    });
    symlinkSync(join(root, 'packages/kernel'), join(base, 'outside-link'));
    expect(pre('Edit', { file_path: join(base, 'outside-link/src/store.ts') }, { cwd: other })).toMatchObject(
      { decision: 'deny' },
    );
    linkSync(join(root, 'packages/kernel/src/store.ts'), join(other, 'hardlink.ts'));
    expect(pre('Edit', { file_path: join(other, 'hardlink.ts') }, { cwd: other })).toMatchObject({
      decision: 'deny',
    });
    expect(
      pre('Edit', { file_path: join(other, 'packages/kernel/src/store.ts') }, { cwd: other }),
    ).toMatchObject({ decision: 'allow' });
  });

  it("protects AOC's own audit state (event DB, anchor repo, external log) for every managed session", () => {
    const db = join(a.t.dataDir, 'aoc.db');
    expect(pre('Write', { file_path: db }, { cwd: other })).toMatchObject({ decision: 'deny' });
    expect(
      pre(
        'Edit',
        { file_path: join(a.t.config.audit.anchorRepoPath, 'anchors/2026-10-09-1.json') },
        { cwd: other },
      ),
    ).toMatchObject({ decision: 'deny' });
    expect(bash(`sqlite3 ${db} "DROP TRIGGER events_append_only_u"`, other)).toMatchObject({
      decision: 'deny',
    });
    expect(bash(`: > ${a.t.config.selfModification.externalAuditLog}`, other).reason).toMatch(
      /AOC audit state/,
    );
    const rules = a.t.rt.store.list({ types: ['selfmod.blocked'] }).map((e) => e.meta.rule);
    expect(rules).toEqual(
      expect.arrayContaining(['audit_store.edit', 'audit_store.command', 'audit_store.redirect']),
    );
  });
});

describe('self-modification guard: Bash', () => {
  const denied = [
    'echo x > packages/kernel/src/a.ts',
    'echo x >> packages/kernel/src/a.ts',
    'cat /tmp/x | tee packages/kernel/src/a.ts',
    "sed -i 's/a/b/' packages/kernel/src/store.ts",
    "sed -i.bak -e 's/a/b/' config/rate-card.json",
    "perl -pi -e 's/a/b/' packages/mod-audit/src/index.ts",
    'mv packages/kernel/src/store.ts /tmp/store.ts',
    'mv -i packages/kernel/src/store.ts /tmp/',
    'mv /tmp/evil.ts packages/kernel/src/store.ts',
    'mv /tmp/newpkg packages/', // could arrive with its own package.json (packages/*/package.json is Tier 1)
    'cp /tmp/evil.ts packages/kernel/src/store.ts',
    'cp -r /tmp/evil/. packages/kernel/',
    'cp -t packages/kernel /tmp/evil.ts',
    'install -m 644 /tmp/evil.ts packages/kernel/src/store.ts',
    'rm -f packages/kernel/src/store.ts',
    'rm -rf packages',
    'rm -rf .',
    'truncate -s 0 packages/kernel/src/store.ts',
    'touch -m packages/kernel/src/store.ts',
    'dd if=/dev/zero of=packages/kernel/src/store.ts count=1',
    'ln -s ../kernel packages/mod-tower/k2',
    'git checkout -- packages/kernel/src/store.ts',
    'git checkout HEAD~1 -- packages/kernel',
    'git checkout -- .',
    'git restore packages/mod-audit/',
    'git -C packages rm -r kernel',
    'git apply fix.patch',
    'patch -p1 < fix.patch',
    `git apply <<'EOF'\n${KERNEL_PATCH}EOF`,
    'curl -s https://example.test/p.diff | git apply',
    'cd packages/kernel && echo x > src/a.ts',
    'cd packages && rm -rf kernel',
    'sudo -u root rm -rf packages/kernel',
    'env FOO=1 bash -c "echo > config/x.json"',
    `bash -lc 'rm -f packages/mod-audit/src/index.ts'`,
    `echo 'echo x > packages/kernel/a.ts' | sh`,
    `sh <<'EOF'\nprintf x > config/rate-card.json\nEOF`,
    `python3 -c "open('packages/kernel/src/a.ts','w').write('x')"`,
    `node -e "require('fs').writeFileSync('packages/kernel/src/a.ts', '')"`,
    `awk 'BEGIN { print "x" > "config/rate-card.json" }'`,
    "find packages/kernel -name '*.ts' -delete",
    "find packages/kernel -name '*.ts' -exec sed -i s/a/b/ {} \\;",
    "find packages/kernel -name '*.ts' | xargs rm",
    'for f in packages/kernel/src/*.ts; do rm "$f"; done',
    'while read f; do rm "$f"; done < <(ls packages/kernel/src/*.ts)',
    'echo x > packages/{mod-tower,kernel}/src/a.ts',
    'echo x > packages/kern*/src/a.ts',
    'echo x > ./packages/mod-tower/../kernel/src/a.ts',
    'echo x > "packages/kernel/src/$NAME"',
    'X=$(echo x > packages/kernel/src/a.ts)',
    'P=packages/kernel; echo x > $P/src/a.ts',
    'export T=config/rate-card.json && cp /tmp/x "$T"',
    'echo x > $(echo packages/kernel/src/a.ts)',
    '$EDITOR packages/kernel/src/store.ts',
    '$(echo rm) -rf packages/kernel',
  ];
  it.each(denied)('denies: %s', (cmd) => {
    const r = bash(cmd);
    expect(r).toMatchObject({
      decision: 'deny',
      guard: 'self-modification',
      blockReason: 'self_modification',
    });
  });

  const allowed = [
    'cat packages/kernel/src/store.ts',
    'grep -rn foo packages/kernel 2>/dev/null',
    'ls -la packages/kernel > /tmp/listing.txt',
    'git diff packages/kernel',
    'git log -- packages/kernel',
    'git checkout -b feature/ledger',
    'cp packages/kernel/src/store.ts /tmp/copy.ts',
    'echo x > packages/mod-tower/src/x.ts',
    'rm -rf packages/mod-tower/dist node_modules',
    'mv /tmp/evil mocks/',
    "sed -n '1,10p' packages/kernel/src/store.ts",
    'npm test > $LOG 2>&1',
    'pnpm --filter @aoc/kernel test',
    'git apply ledger.patch',
    `python3 -c "print(open('packages/kernel/src/store.ts').read())"`,
    "find packages/kernel -name '*.ts' | xargs grep -n TODO",
    'for f in packages/kernel/src/*.ts; do wc -l "$f"; done',
    'OUT=/tmp/out.txt; cat packages/kernel/src/store.ts > $OUT',
    'K=packages/kernel; grep -rn TODO $K',
  ];
  it.each(allowed)('allows: %s', (cmd) => {
    expect(bash(cmd)).toMatchObject({ decision: 'allow' });
  });

  it('allows the same commands in a non-AOC repo', () => {
    for (const cmd of [
      'echo x > packages/kernel/src/a.ts',
      'rm -rf packages',
      'git apply fix.patch',
      'curl -s https://x/p.diff | git apply',
    ]) {
      expect(bash(cmd, other)).toMatchObject({ decision: 'allow' });
    }
    expect(bash(`echo x > ${join(root, 'packages/kernel/src/a.ts')}`, other)).toMatchObject({
      decision: 'deny',
    });
  });

  it('treats a nested repository inside the AOC tree (a project workspace) as a different repo', () => {
    const ws = join(root, '.aoc/workspaces/proj');
    mkdirSync(join(ws, '.git'), { recursive: true });
    expect(bash('curl -s https://example.test/p.diff | git apply', ws)).toMatchObject({ decision: 'allow' });
    expect(bash('mkdir -p packages/kernel && echo x > packages/kernel/a.ts', ws)).toMatchObject({
      decision: 'allow',
    });
    expect(bash('echo x > ../../../packages/kernel/src/a.ts', ws)).toMatchObject({ decision: 'deny' });
  });

  it('labels the rule by area and route', () => {
    const before = a.t.rt.store.head().seq;
    bash('echo x > packages/kernel/src/a.ts');
    bash('rm -rf packages/kernel');
    bash('curl -s https://x/p.diff | git apply');
    bash(`python3 -c "open('config/a.json','w')"`);
    const rules = a.t.rt.store
      .list({ fromSeq: before + 1, types: ['selfmod.blocked'] })
      .map((e) => e.meta.rule);
    expect(rules).toEqual(['core.redirect', 'core.command', 'core.patch_unverifiable', 'core.interpreter']);
  });
});

describe('BoundaryMatcher', () => {
  it('treats prefixes without a trailing slash as string prefixes and supports globs', () => {
    const m = new BoundaryMatcher({
      aocRepoPaths: ['/r'],
      protectedPaths: ['packages/mod-cred', 'docs/*/secret/', 'CLAUDE.md'],
      auditStorePaths: [],
    });
    expect(m.check('/r/packages/mod-credits/a.ts', '/', false)?.pattern).toBe('packages/mod-cred');
    expect(m.check('/r/docs/x/secret/y', '/', false)?.pattern).toBe('docs/*/secret/');
    expect(m.check('/r/CLAUDE.md', '/', false)).not.toBeNull();
    expect(m.check('/r/docs/x/public/y', '/', false)).toBeNull();
    expect(m.check('/r/docs', '/', false)).toBeNull();
    expect(m.check('/r/docs', '/', true)).not.toBeNull();
    expect(m.check('/', '/', true)).not.toBeNull();
    expect(m.repoOf('/r/packages')).toBe('/r');
    expect(m.repoOf('/rx')).toBeNull();
  });
});

describe('default protectedPaths (Tier 1 of the boundary)', () => {
  const m = new BoundaryMatcher({ aocRepoPaths: ['/r'], protectedPaths: [...DEFAULT_PROTECTED_PATHS], auditStorePaths: [] });
  const hit = (p: string) => m.check(`/r/${p}`, '/', false) !== null;

  it('covers every package that enforces governance, audit, credits, ingest or launch, and the build and rule files', () => {
    const tier1 = ['kernel', 'contracts', 'mod-audit', 'mod-credits', 'mod-decisions', 'mod-identity', 'hooks', 'supervisor', 'mod-change', 'mod-sessions', 'mod-ledger', 'mod-metering', 'mod-registry', 'distill', 'mod-evidence', 'daemon', 'client', 'mcp-server', 'sidecar'];
    for (const pkg of tier1) expect(hit(`packages/${pkg}/src/index.ts`), pkg).toBe(true);
    for (const f of ['config/rate-card.json', 'package.json', 'packages/web/package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'scripts/check.sh', '.github/CODEOWNERS', 'CLAUDE.md', 'docs/spec/AOC-SPEC-003.md', 'docs/compliance/gaps.md'])
      expect(hit(f), f).toBe(true);
  });

  it('leaves the feature packages and ordinary documentation to normal change control', () => {
    for (const f of ['packages/web/src/App.tsx', 'packages/mod-tower/src/index.ts', 'packages/mod-learning/src/index.ts', 'packages/mod-fx/src/index.ts', 'packages/mod-intake/src/index.ts', 'packages/llm/src/index.ts', 'packages/cli/src/index.ts', 'packages/claude-sim/src/index.ts', 'packages/demo/src/seed.ts', 'mocks/index.html', 'docs/architecture.md', 'README.md'])
      expect(hit(f), f).toBe(false);
  });
});

describe('self-modification guard: degraded external log', () => {
  it('still denies (and says so in the chain) when the external audit log cannot be written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aoc-extlog-'));
    const x = await auditRuntime({
      config: { selfModification: { aocRepoPaths: [root], externalAuditLog: dir } },
    });
    try {
      const s = x.t.sessions!.add({ sessionId: 'ses_agent2', mode: 'managed', cwd: root });
      const r = x.t.rt.policy.evaluate({
        session: s,
        mode: 'managed',
        toolName: 'Edit',
        toolInput: { file_path: join(root, 'packages/kernel/src/store.ts') },
        cwd: root,
      });
      expect(r.decision).toBe('deny');
      expect(x.t.rt.store.list({ types: ['selfmod.blocked'] }).at(-1)!.meta.externalLogged).toBe(false);
    } finally {
      await x.t.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('self-modification service for the promotion gate (G-41)', () => {
  it('names the core files of an AOC repo only (not of another or a nested repo)', () => {
    const svc = a.t.rt.services.get('selfmod');
    expect(svc.coreFiles(other, FILES)).toBeNull();
    expect(svc.coreFiles(root, [])).toEqual([]);
    expect(svc.coreFiles(root, FILES)).toEqual([
      'packages/kernel/src/store.ts',
      'packages/mod-audit/src/index.ts',
      'config/rate-card.json',
      'CLAUDE.md',
    ]);
    const nested = join(root, 'nested-ws');
    mkdirSync(join(nested, '.git'), { recursive: true });
    try {
      expect(svc.coreFiles(nested, ['packages/kernel/src/store.ts'])).toBeNull();
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  });

  it('appends hash-chained lines to the external log; callers cannot set ts or chainId', () => {
    const svc = a.t.rt.services.get('selfmod');
    expect(
      svc.recordExternal({
        kind: 'selfmod.promotion_refused',
        commits: ['abc1234'],
        ts: 'forged',
        chainId: 'x',
      }),
    ).toBe(true);
    const text = readFileSync(a.t.config.selfModification.externalAuditLog, 'utf8');
    expect(verifyExternalAuditLog(text)).toBeNull();
    const last = JSON.parse(text.trim().split('\n').at(-1)!) as Record<string, unknown>;
    expect(last).toMatchObject({
      kind: 'selfmod.promotion_refused',
      commits: ['abc1234'],
      v: 1,
      ts: a.t.clock.iso(),
      chainId: a.t.rt.store.chainId,
    });
  });
});

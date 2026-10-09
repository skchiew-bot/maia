import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Actor } from '@aoc/contracts';
import type { ModuleContext } from '@aoc/kernel';
import type { IdentityServiceImpl } from './service';
import { generateToken } from './tokens';

export const BOOTSTRAP_TOKEN_ENV = 'AOC_BOOTSTRAP_TOKEN';
const BOOTSTRAP_ACTOR: Actor = { kind: 'system', id: 'identity:bootstrap' };
/** Operator-supplied tokens must carry real entropy: their sha256 is chained in clear. */
const BOOTSTRAP_TOKEN_RE = /^aoc_u_[0-9A-Za-z]{32,128}$/;

export interface BootstrapResult {
  created: boolean;
  userId: string | null;
  tokenFile: string | null;
  source: 'env' | 'file' | null;
}

export function bootstrapTokenPath(ctx: ModuleContext): string | null {
  if (ctx.config.identity.bootstrapTokenFile) return resolve(ctx.config.identity.bootstrapTokenFile);
  return ctx.dataDir === ':memory:' ? null : join(ctx.dataDir, 'bootstrap-token');
}

/** Write a secret atomically with 0600 (exclusive-create temp file, then rename over the target). */
function writeSecretFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * First start with no users: create the first Approver ("Owner") with a user token taken from
 * AOC_BOOTSTRAP_TOKEN, or generated and written to <dataDir>/bootstrap-token (0600). The token itself is
 * never logged; only the file path is. Runs once: any user.created in the log disables it for good.
 */
export function bootstrapFirstApprover(
  service: IdentityServiceImpl,
  ctx: ModuleContext,
  env: Record<string, string | undefined>,
): BootstrapResult {
  const none: BootstrapResult = { created: false, userId: null, tokenFile: null, source: null };
  if (service.hasUserEvents()) return none;
  const owner = { role: 'approver' as const, name: 'Owner' };
  const fromEnv = env[BOOTSTRAP_TOKEN_ENV]?.trim();
  if (fromEnv) {
    if (!BOOTSTRAP_TOKEN_RE.test(fromEnv)) {
      throw new Error(
        `${BOOTSTRAP_TOKEN_ENV} must be "aoc_u_" followed by 32-128 letters or digits (e.g. aoc_u_$(openssl rand -hex 24)); refusing to bootstrap with it`,
      );
    }
    const { user, issued } = service.createUserWithToken(
      owner,
      { token: fromEnv, label: 'bootstrap' },
      BOOTSTRAP_ACTOR,
    );
    ctx.log.info('identity bootstrap: first Approver created with the token from the environment', {
      userId: user.id,
      tokenId: issued.tokenId,
      env: BOOTSTRAP_TOKEN_ENV,
    });
    return { created: true, userId: user.id, tokenFile: null, source: 'env' };
  }
  const file = bootstrapTokenPath(ctx);
  if (!file) {
    ctx.log.warn(
      `identity bootstrap skipped: in-memory data dir and no ${BOOTSTRAP_TOKEN_ENV}, so a first token could not be delivered`,
    );
    return none;
  }
  const token = generateToken('user');
  // File first: if the append fails the file is removed; if we crash in between, the next start re-runs bootstrap.
  writeSecretFile(file, `${token}\n`);
  let userId: string;
  try {
    userId = service.createUserWithToken(owner, { token, label: 'bootstrap' }, BOOTSTRAP_ACTOR).user.id;
  } catch (err) {
    rmSync(file, { force: true });
    throw err;
  }
  ctx.log.warn(
    'identity bootstrap: first Approver "Owner" created; its token is in the file (0600). Log in, create a personal token, then revoke the bootstrap token and delete the file.',
    {
      userId,
      tokenFile: file,
    },
  );
  return { created: true, userId, tokenFile: file, source: 'file' };
}

/**
 * Environment for helper processes aocd spawns itself (kernel git, the anchor git and openssl, the claude CLI of the
 * LLM adapter, the ClamAV client). aocd's own environment may hold AOC_MASTER_KEY (development), AOC_BOOTSTRAP_TOKEN,
 * ANTHROPIC_API_KEY or deploy tokens, and a child inherits everything it is given — so children get an allowlist,
 * plus only what each one needs, never `process.env` (threat model O-13, T-18).
 */
export const CHILD_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  'TMPDIR',
  'TERM',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
];

/** The allowlisted part of `source`, then `extra` (explicit values from the caller win). */
export function childEnv(
  source: Record<string, string | undefined> = process.env,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of CHILD_ENV_ALLOWLIST) {
    const v = source[k];
    if (typeof v === 'string') env[k] = v;
  }
  return { ...env, ...extra };
}

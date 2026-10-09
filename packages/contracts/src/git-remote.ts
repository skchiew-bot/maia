/**
 * The remotes AOC pushes to with a credential (promotion, rollback, break-glass, a session's allowed branches): one rule
 * for the configuration that names them (`promotion` in config.ts), mod-change and the supervisor's push gateway.
 */

/** Transports a protected remote may use. Plain http, git://, ext:: and helper URLs are refused. */
export type GitTransport = 'ssh' | 'https' | 'file';

/**
 * How git would reach `url`: the one transport AOC may open, or null for anything else (ext::, fd::, plain http, an
 * option-looking string, a relative path).
 */
export function transportOf(url: string): GitTransport | null {
  if (!url || url.startsWith('-') || /[\s\0]/.test(url)) return null;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url)?.[1]?.toLowerCase();
  if (scheme) return scheme === 'https' || scheme === 'ssh' || scheme === 'file' ? scheme : null;
  if (url.startsWith('/')) return 'file';
  // scp-like `[user@]host:path`: a colon before any slash (git's own rule), and no `<helper>::` syntax.
  return /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+:(?!:)/.test(url) ? 'ssh' : null;
}

/**
 * Why `url` cannot be configured as a promotion remote, or null when it can: a transport AOC opens, and no credential
 * in it. The credential belongs to the promotion credential profile; a configuration file may sit in a repository.
 */
export function promotionRemoteProblem(url: string): string | null {
  if (transportOf(url) === null) return 'must be an ssh, https or absolute local-path remote';
  const userInfo = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/@]*)@/.exec(url)?.[1];
  // `ssh://git@host/…` only names the user; anything before an @ on https or file, or a password on ssh, is a secret.
  if (userInfo !== undefined && (!url.toLowerCase().startsWith('ssh://') || userInfo.includes(':')))
    return 'must not embed credentials: the promotion credential profile carries them';
  return null;
}

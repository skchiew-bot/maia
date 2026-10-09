import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Actor, AocConfig, EventSource, StoredEvent } from '@aoc/contracts';
import { canonicalJson, sha256hex, type EventStore } from '@aoc/kernel';

/** Recorded when a governed file disappears. */
export const ABSENT_HASH = sha256hex('aoc-governed-config:absent');

export interface GovernedSource {
  key: string;
  /** Hash of the current state; null when the file is not there. */
  current(): string | null;
  /** Tracked only once it has existed (e.g. the ISO 42001 mapping, which may not be written yet). */
  optional: boolean;
}

function fileSource(key: string, path: string, optional = false): GovernedSource {
  return {
    key,
    optional,
    current: () => {
      try {
        return sha256hex(readFileSync(path));
      } catch {
        return null;
      }
    },
  };
}

/**
 * Governed configuration: the process-type registry, the rate card, the ISO 42001 mapping, the credential profiles
 * file (existence + mode only — its content is deploy credentials, §3), the audit / self-modification settings
 * themselves (weakening the boundary must leave a trace in the chain), and the decision, credit and liveness policy.
 */
export function governedSources(
  config: AocConfig,
  opts: { mappingFile?: string } = {},
  baseDir = process.cwd(),
): GovernedSource[] {
  const sources: GovernedSource[] = [
    fileSource('registry_file', resolve(baseDir, config.registryFile)),
    fileSource('rate_card_file', resolve(baseDir, config.metering.rateCardFile)),
    fileSource(
      'iso42001_mapping',
      resolve(baseDir, opts.mappingFile ?? 'config/iso42001-mapping.json'),
      true,
    ),
    { key: 'audit_config', optional: false, current: () => sha256hex(canonicalJson(config.audit)) },
    {
      key: 'selfmod_config',
      optional: false,
      current: () => sha256hex(canonicalJson(config.selfModification)),
    },
    // Who may approve what (e.g. the sole-Approver fallback, off by CEO decision), how credits cap and auto-grant,
    // and when a session counts as stalled or dead: changing any of them must leave a trace in the chain.
    { key: 'decisions_config', optional: false, current: () => sha256hex(canonicalJson(config.decisions)) },
    { key: 'credits_config', optional: false, current: () => sha256hex(canonicalJson(config.credits)) },
    { key: 'liveness_config', optional: false, current: () => sha256hex(canonicalJson(config.liveness)) },
  ];
  const creds = config.supervisor.credentialProfilesFile;
  if (creds) {
    const path = resolve(baseDir, creds);
    sources.push({
      key: 'credential_profiles',
      optional: false,
      current: () => {
        try {
          const st = statSync(path);
          return sha256hex(canonicalJson({ exists: true, mode: (st.mode & 0o7777).toString(8) }));
        } catch {
          return sha256hex(canonicalJson({ exists: false }));
        }
      },
    });
  }
  return sources;
}

/** Compare each governed source with the last recorded hash (aud_config) and append config.changed on any difference. */
export function detectConfigChanges(
  store: EventStore,
  db: DatabaseSync,
  sources: GovernedSource[],
  actor: Actor,
  source: EventSource,
): StoredEvent[] {
  const rows = db.prepare('SELECT key, version_hash FROM aud_config').all() as {
    key: string;
    version_hash: string;
  }[];
  const previous = new Map(rows.map((r) => [r.key, r.version_hash]));
  const out: StoredEvent[] = [];
  for (const s of sources) {
    const prev = previous.get(s.key) ?? null;
    let cur = s.current();
    if (cur === null) {
      if (s.optional && prev === null) continue;
      cur = ABSENT_HASH;
    }
    if (cur === prev) continue;
    out.push(
      store.append({
        type: 'config.changed',
        actor,
        meta: { key: s.key, versionHash: cur, previousHash: prev },
        source,
      }),
    );
  }
  return out;
}

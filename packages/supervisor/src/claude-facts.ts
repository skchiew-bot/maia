/**
 * Claude Code 2.1.295 facts the supervisor needs that reach @aoc/contracts with the lead's verified-facts commit
 * (46b3d00: THROTTLE_RESET, RATE_LIMIT_429, the 2.x THROTTLE_PATTERNS, the extended HOOK_EVENTS and
 * ProcessType.builtinTools). Contract exports win whenever they are present, so this file can be deleted after
 * that merge without any change in behaviour.
 */
import * as contracts from '@aoc/contracts';
import { HOOK_EVENTS, type ProcessType } from '@aoc/contracts';

type VerifiedExports = Partial<{ THROTTLE_RESET: RegExp; RATE_LIMIT_429: RegExp }>;
const merged = contracts as typeof contracts & VerifiedExports;

/** Reset time: group 1 = "3pm" | "12:50am" | "Oct 14, 3pm" | "Nov 13"; group 2 = IANA zone if present. */
export const THROTTLE_RESET: RegExp =
  merged.THROTTLE_RESET ??
  /(?:[·∙•-]\s*resets?|Resets? at|reset at)\s+((?:[A-Z][a-z]{2} \d{1,2}(?:, \d{4})?(?:, \d{1,2}(?::\d{2})?\s?(?:am|pm))?)|\d{1,2}(?::\d{2})?\s?(?:am|pm))(?:\s*\(([^)]+)\))?/i;

/** Short-term API rate limit (HTTP 429): Throttled with an unknown reset. */
export const RATE_LIMIT_429: RegExp =
  merged.RATE_LIMIT_429 ?? /API Error: Rate limit reached|rate_limit_error/i;

/** Plan-limit text (fallback signal). The pre-merge contract patterns match none of the 2.x messages. */
export const THROTTLE_TEXT_PATTERNS: readonly RegExp[] = merged.THROTTLE_RESET
  ? contracts.THROTTLE_PATTERNS
  : [
      /You['’]ve hit your (?:[\w'’ ]{1,40} )?(?:limit|budget)/i,
      /You['’]ve reached your [\w ]{1,40} limit/i,
      /You['’]re out of (?:usage credits|extra usage)/i,
      /Your org is out of usage/i,
      /Claude AI usage limit reached\|(\d{9,13})/i,
      /(?:\d+-hour|weekly|session|opus(?: weekly)?)\s+limit reached/i,
      /usage limit reached/i,
    ];

/** Hook events verified to exist in 2.1.295 (unknown keys are silently dropped from settings in -p mode). */
const VERIFIED_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'PermissionRequest',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
] as const;

/** Every hook event a managed session registers: the contract list plus the verified 2.1.x additions. */
export const MANAGED_HOOK_EVENTS: readonly string[] = [
  ...new Set<string>([...HOOK_EVENTS, ...VERIFIED_HOOK_EVENTS]),
];

/** `ProcessType.builtinTools` → `--tools` (e.g. ["Read","Glob","Grep"] for read-only triage). */
export function builtinToolsOf(t: ProcessType): string[] | undefined {
  const v = (t as ProcessType & { builtinTools?: unknown }).builtinTools;
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
}

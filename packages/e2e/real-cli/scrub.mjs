#!/usr/bin/env node
// Turns what a real-CLI run captured (AOC_REAL_CLI_CAPTURE: raw stream-json, hooks.jsonl, transcripts) into a fixture
// that is safe to commit: paths of the run's temp dirs, emails, local ports and opaque API ids are rewritten, thinking
// signatures and the bulky prompt / tool-schema / skill attachments are dropped, and partial-message lines are
// left out. Nothing here knows the account the run used; check a fixture with grep before committing it all the same.
//
//   node real-cli/scrub.mjs stream     <capture>/<session>.turn-1.stream.jsonl            <out>.jsonl
//   node real-cli/scrub.mjs transcript <capture>/<dump>/transcript.jsonl                  <out>.jsonl
//   node real-cli/scrub.mjs hooks      <capture>/hooks.jsonl <out>.jsonl <claude-session-id>
//
// Opaque ids (msg_*, req_*) are renumbered in order of appearance per scrubber: import { makeScrubber, scrub } and share
// one scrubber between the stream and the transcript of a session if their message ids must still match.
import fs from 'node:fs';

const PATHS = [
  [/\/\S*?node\S* \/\S*\/hook-tee\.mjs \/\S+ /g, ''],
  [/\/\S*\/bin\/node\b/g, 'node'],
  [/\/tmp\/aoc-e2e-bin-[A-Za-z0-9]+\//g, '/tmp/aoc-real/bin/'],
  [/\/tmp\/aoc-e2e-[A-Za-z0-9]+\/claude-config/g, '/tmp/aoc-real/claude-config'],
  [/\/tmp\/aoc-e2e-[A-Za-z0-9]+\/repos\//g, '/tmp/aoc-real/repos/'],
  [/\/tmp\/aoc-e2e-[A-Za-z0-9]+\/sessions\//g, '/tmp/aoc-real/sessions/'],
  [/\/tmp\/aoc-e2e-[A-Za-z0-9]+\//g, '/tmp/aoc-real/'],
  [/\/tmp\/aoc-real-cli-[A-Za-z0-9]+\//g, '/tmp/aoc-real/'],
  [/-tmp-aoc-e2e-[A-Za-z0-9]+-repos-/g, '-tmp-aoc-real-repos-'],
  [/\/tmp\/cc-socks\/\d+\.sock/g, '/tmp/cc-socks/0.sock'],
  [/[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => (/^(cc-plugin-[a-z-]+@builtin)$/.test(m) ? m : 'noreply@example.invalid')],
  [/127\.0\.0\.1:\d+/g, '127.0.0.1:PORT'],
];
const OMIT_ATTACHMENTS = new Set(['prompt_snapshot', 'skill_listing', 'agent_listing_delta', 'remote_session_change']);

export function makeScrubber() {
  const ids = new Map();
  const renumber = (prefix, id) => {
    const key = prefix + id;
    if (!ids.has(key)) ids.set(key, `${prefix}fixture_${String(ids.size + 1).padStart(3, '0')}`);
    return ids.get(key);
  };
  const str = (s) => {
    let out = s;
    for (const [re, to] of PATHS) out = out.replace(re, to);
    return out.replace(/\b(msg_|req_)([A-Za-z0-9]{10,})\b/g, (_, p, id) => renumber(p, id));
  };
  const walk = (v, key) => {
    if (typeof v === 'string') return key === 'signature' ? '<omitted>' : str(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return { walk };
}

function transcriptLine(o) {
  const a = o.attachment;
  const t = a?.type;
  if (t && OMIT_ATTACHMENTS.has(t)) {
    if (t === 'prompt_snapshot') {
      a.systemPrompt = '<omitted>';
      if ('tools' in a) a.tools = '<omitted>';
    }
    if (t === 'skill_listing') Object.assign(a, { content: '<omitted>', names: ['<omitted>'] });
    if (t === 'agent_listing_delta') Object.assign(a, { addedTypes: ['<omitted>'], addedLines: ['<omitted>'], builtInTypes: ['<omitted>'] });
    if (t === 'remote_session_change') Object.assign(a, { commit: '<omitted>', pr: '<omitted>' });
    if (o.rendered) o.rendered = [{ content: '<omitted>' }];
  }
  if (t === 'environment') {
    if (a.snapshot) a.snapshot.osVersion = '<redacted>';
    if (o.rendered) o.rendered = [{ content: '<omitted>' }];
  }
  return o;
}

const read = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

export function scrub(kind, input, claudeSession, scrubber = makeScrubber()) {
  const lines = read(input);
  const out =
    kind === 'stream'
      ? lines.filter((o) => o.type !== 'stream_event')
      : kind === 'transcript'
        ? lines.map(transcriptLine)
        : kind === 'hooks'
          ? lines.filter((h) => h.input?.session_id === claudeSession)
          : (() => {
              throw new Error(`unknown kind ${kind}: stream, transcript or hooks`);
            })();
  return out.map((o) => scrubber.walk(o));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [kind, input, output, claudeSession] = process.argv.slice(2);
  if (!kind || !input || !output) {
    console.error('usage: scrub.mjs stream|transcript|hooks <input.jsonl> <output.jsonl> [claude-session-id]');
    process.exit(2);
  }
  const lines = scrub(kind, input, claudeSession);
  fs.writeFileSync(output, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
  console.log(`${output}: ${lines.length} lines`);
}

import {
  MAPPING_PROVISIONAL_BANNER,
  type EvidenceBreakglassFile,
  type EvidenceChanges,
  type EvidenceControls,
  type EvidenceCredits,
  type EvidenceFx,
  type EvidenceGates,
  type EvidencePackFileEntry,
  type EvidencePackManifest,
  type EvidenceNotVerifiableReason,
  type EvidenceRollbacks,
  type EvidenceVerification,
} from '@aoc/contracts';

const NOT_VERIFIABLE: Record<EvidenceNotVerifiableReason, string> = {
  audit_service_unavailable: 'the audit service was not running',
  audit_verify_failed: 'the off-host verification could not run',
  off_host_record_unavailable: 'an off-host anchor record could not be read',
  anchors_not_off_host: 'some anchors are not held off-host (no anchor remote, or not pushed yet)',
  no_anchors: 'the log has never been anchored off-host',
};

export interface ReportInput {
  manifest: Omit<EvidencePackManifest, 'files'>;
  /** Every pack file except index.html and manifest.json (which lists index.html's own hash). */
  dataFiles: EvidencePackFileEntry[];
  verification: EvidenceVerification;
  controls: EvidenceControls;
  gates: EvidenceGates;
  changes: EvidenceChanges;
  rollbacks: EvidenceRollbacks;
  breakglass: EvidenceBreakglassFile;
  credits: EvidenceCredits;
  fx: EvidenceFx;
}

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape any value for HTML text and attribute context. */
export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]!);
}

const yesNo = (b: boolean) => (b ? 'yes' : 'no');
const row = (cells: unknown[]) => `<tr>${cells.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`;
const dl = (pairs: [string, unknown][]) =>
  `<dl class="facts">${pairs.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
const counts = (rec: Record<string, number>) =>
  Object.entries(rec)
    .map(([k, n]) => `${k} ${n}`)
    .join(', ') || 'none';

function banner(r: ReportInput): string {
  const m = r.manifest.mapping;
  const out: string[] = [];
  if (m.status === 'stamped') {
    out.push(
      `<div class="banner stamped" role="status"><strong>${esc(m.statement)}</strong> (${esc(m.stampedBy)}, mapping ${esc(m.version)}).</div>`,
    );
  } else {
    out.push(
      `<div class="banner provisional" role="alert"><strong>${esc(MAPPING_PROVISIONAL_BANNER)}.</strong> ` +
        `Compliance mapping ${esc(m.version)} is ${esc(m.statement)}. Clause numbers must be confirmed against ${esc(m.standard)} before this pack is cited (AOC-SPEC-003 R3).</div>`,
    );
  }
  const v = r.verification;
  if (v.status === 'failed') {
    out.push(
      `<div class="banner danger" role="alert"><strong>Integrity check failed.</strong> Chain ok: ${esc(yesNo(v.chain.ok))}; ` +
        `anchors confirmed off-host ${esc(v.anchorsMatched)} of ${esc(v.anchorsChecked)}; first bad seq ${esc(v.chain.firstBadSeq ?? 'n/a')}. See verification.json.</div>`,
    );
  } else if (v.status === 'not_verifiable') {
    out.push(
      `<div class="banner provisional" role="alert"><strong>Not verifiable against the off-host anchors:</strong> ` +
        `${esc(v.notVerifiableReason ? NOT_VERIFIABLE[v.notVerifiableReason] : 'unknown reason')}. ` +
        `The pack only shows that the log agrees with itself, which anyone with file access can arrange (AOC-SPEC-003 R2).</div>`,
    );
  }
  return out.join('\n');
}

function anchorRows(v: EvidenceVerification): string {
  return v.anchors
    .map((a) => {
      const x = a.external;
      const record = x ? `${x.record}${x.hash ? ` ${x.hash.slice(0, 16)}…` : ''}` : 'not checked';
      return (
        `<tr><td class="num">${esc(a.seq)}</td><td>${esc(a.provider)}</td><td class="mono">${esc(a.anchoredHash.slice(0, 16))}…</td>` +
        `<td class="mono">${esc(record)}</td><td>${esc(x ? yesNo(x.matched) : 'n/a')}</td><td>${esc(x ? yesNo(x.proofOk) : 'n/a')}</td>` +
        `<td>${esc(x ? yesNo(x.offHost) : 'n/a')}</td><td>${esc(a.matched ? 'confirmed' : 'NOT confirmed')}</td></tr>`
      );
    })
    .join('');
}

const STATUS_LABEL = {
  verified: 'verified against the off-host anchors',
  failed: 'FAILED',
  not_verifiable: 'NOT VERIFIABLE off-host',
} as const;

const STYLE = `
:root{--bg:#fff;--fg:#16181d;--muted:#5b616e;--line:#d9dce3;--warn-bg:#fff4e5;--warn-fg:#6b3500;--warn-line:#d98a1c;--ok-bg:#e9f7ef;--ok-fg:#14532d;--ok-line:#3f9a63;--bad-bg:#fdecec;--bad-fg:#8a1c1c;--bad-line:#d14343}
@media (prefers-color-scheme:dark){:root{--bg:#111317;--fg:#e7e9ee;--muted:#a2a8b5;--line:#2c313b;--warn-bg:#3a2a12;--warn-fg:#ffd9a0;--warn-line:#b9822d;--ok-bg:#12291c;--ok-fg:#9be2b5;--ok-line:#3f9a63;--bad-bg:#3a1515;--bad-fg:#ffb4b4;--bad-line:#d14343}}
*{box-sizing:border-box}body{margin:0;padding:24px 16px 48px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1100px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
.sub,.muted{color:var(--muted)}.banner{border:2px solid;border-radius:6px;padding:12px 14px;margin:16px 0}
.provisional{background:var(--warn-bg);color:var(--warn-fg);border-color:var(--warn-line)}
.stamped{background:var(--ok-bg);color:var(--ok-fg);border-color:var(--ok-line)}
.danger{background:var(--bad-bg);color:var(--bad-fg);border-color:var(--bad-line)}
.facts{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px 16px;margin:0}
.facts div{border-bottom:1px solid var(--line);padding:4px 0}dt{color:var(--muted);font-size:12px}dd{margin:0;word-break:break-word}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;color:var(--muted)}
.num{text-align:right}.mono,td.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all}
footer{margin-top:32px;font-size:12px}
`;

export function renderReport(r: ReportInput): string {
  const m = r.manifest;
  const v = r.verification;
  const rows = r.controls.rows
    .map(
      (c) =>
        `<tr><td class="mono">${esc(c.clause)}</td><td>${esc(c.clauseTitle)}</td><td>${esc(c.aocControl)}</td>` +
        `<td class="num">${esc(c.total)}</td><td class="muted">${esc(c.documentaryOnly ? 'documentary evidence only' : counts(c.counts))}</td><td>${esc(c.status)}</td></tr>`,
    )
    .join('');
  const findings = [
    ...r.gates.gates
      .filter((g) => g.flags.length)
      .map((g) => ['Gate', `${g.decisionId} (${g.kind})`, g.flags.join(', ')]),
    ...r.rollbacks.rollbacks
      .filter((x) => x.flags.length)
      .map((x) => ['Rollback', x.rollbackId, x.flags.join(', ')]),
    ...r.breakglass.incidents
      .filter((x) => x.flags.length)
      .map((x) => ['Break-glass', x.breakglassId, x.flags.join(', ')]),
    ...r.credits.flags.map((f) => ['Credits', f.eventId, f.flag]),
  ]
    .map((cells) => row(cells))
    .join('');
  const files = r.dataFiles
    .map(
      (f) =>
        `<tr><td>${esc(f.path)}</td><td class="num">${esc(f.bytes)}</td><td class="mono">${esc(f.sha256)}</td></tr>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>AOC evidence pack ${esc(m.packId)} (${esc(m.range.from)} to ${esc(m.range.to)})</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header>
<h1>AOC audit evidence pack</h1>
<p class="sub"><span class="mono">${esc(m.packId)}</span> · ${esc(m.range.from)} to ${esc(m.range.to)} (${esc(m.range.timezone)}) · ${esc(m.mapping.standard)}</p>
</header>
${banner(r)}
<section aria-labelledby="h-summary">
<h2 id="h-summary">Summary</h2>
${dl([
  ['Generated at', m.generatedAt],
  ['Generated by', `${m.generatedBy.kind}:${m.generatedBy.id}`],
  ['Range complete', m.range.complete ? 'yes' : 'no (range had not fully elapsed)'],
  ['Events in range', m.eventCount],
  ['Range seqs', m.rangeSeqs.first === null ? 'none' : `${m.rangeSeqs.first} to ${m.rangeSeqs.last}`],
  ['Chain id', m.chainId],
  ['Head seq', m.head.seq],
  ['Head hash', m.head.hash],
  ['Mapping', `${m.mapping.version} (${m.mapping.source}, ${m.mapping.rows} rows)`],
  ['Mapping status', m.mapping.statement],
  ['Mapping hash', m.mapping.hash],
  [
    'Rate card in force',
    m.rateCard ? `v${m.rateCard.version}, effective ${m.rateCard.effectiveFrom}` : 'none published',
  ],
  ['Rate-card versions used by rollups', m.rateCardVersionsUsed.join(', ') || 'none'],
])}
</section>
<section aria-labelledby="h-integrity">
<h2 id="h-integrity">Integrity</h2>
${dl([
  ['Overall', STATUS_LABEL[v.status]],
  ['Chain recomputed', `${v.chain.ok ? 'ok' : 'FAILED'} (${v.chain.checked} events)`],
  ['Anchors confirmed off-host', `${v.anchorsMatched} of ${v.anchorsChecked}`],
  ['Off-host check', v.external ? `${v.external.verifiedAt}${v.external.remoteChecked === false ? ' (anchor remote unreachable)' : ''}` : 'not run'],
  ['Range covered by an anchor', yesNo(v.rangeCoveredByAnchor)],
  [
    'Anchor before range',
    v.anchorBeforeRange ? `seq ${v.anchorBeforeRange.seq} (${v.anchorBeforeRange.provider})` : 'none',
  ],
  [
    'Anchor after range',
    v.anchorAfterRange ? `seq ${v.anchorAfterRange.seq} (${v.anchorAfterRange.provider})` : 'none',
  ],
  ['Unanchored tail', `${v.unanchoredTail.events} events (${v.unanchoredTail.rangeEvents} in range)`],
  ['Range hashes recomputed', `${v.range.hashesMatched} of ${v.range.hashesRecomputed} match`],
])}
<div class="wrap"><table>
<caption class="muted">Each anchor as the log recorded it, and its off-host record (git commit on the anchor remote, or RFC 3161 token)</caption>
<thead><tr><th scope="col" class="num">Seq</th><th scope="col">Provider</th><th scope="col">Recorded in the log</th><th scope="col">Off-host record</th><th scope="col">Hash matches</th><th scope="col">Proof holds</th><th scope="col">Held off-host</th><th scope="col">Result</th></tr></thead>
<tbody>${anchorRows(v)}</tbody>
</table></div>
</section>
<section aria-labelledby="h-controls">
<h2 id="h-controls">ISO/IEC 42001 controls</h2>
<div class="wrap"><table>
<caption class="muted">Events in range per mapping row (see controls.json for sample event ids)</caption>
<thead><tr><th scope="col">Clause</th><th scope="col">Clause title</th><th scope="col">AOC control</th><th scope="col" class="num">Events</th><th scope="col">By type</th><th scope="col">Status</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
<p class="muted">Event types in range not cited by any row: ${esc(counts(r.controls.unmappedEventTypes))}</p>
</section>
<section aria-labelledby="h-gates">
<h2 id="h-gates">Human gates</h2>
${dl([
  ['Decisions resolved', r.gates.count],
  ['By kind', counts(r.gates.byKind)],
  ['Passkey verified', r.gates.passkeyVerified],
  ['Self-approved', r.gates.selfApproved],
  ['Resolved by policy', r.gates.byPolicy],
  ['Flagged', r.gates.flagged],
])}
</section>
<section aria-labelledby="h-change">
<h2 id="h-change">Change control, rollback and break-glass</h2>
${dl([
  ['Change records', r.changes.count],
  ['Changes by status', counts(r.changes.byStatus)],
  ['Fields affirmed without edit', r.changes.affirmedWithoutEdit],
  ['Rollbacks', `${r.rollbacks.count} (${r.rollbacks.executed} executed, ${r.rollbacks.flagged} flagged)`],
  ['Break-glass incidents', `${r.breakglass.count} (${r.breakglass.flagged} flagged)`],
  ['Break-glass promotions', r.breakglass.breakglassPromotions.length],
])}
</section>
<section aria-labelledby="h-findings">
<h2 id="h-findings">Findings</h2>
${
  findings
    ? `<div class="wrap"><table><thead><tr><th scope="col">Area</th><th scope="col">Subject</th><th scope="col">Flags</th></tr></thead><tbody>${findings}</tbody></table></div>`
    : '<p>No flagged gates, rollbacks, break-glass incidents or credit grants in this range.</p>'
}
</section>
<section aria-labelledby="h-credits">
<h2 id="h-credits">Credits and FX</h2>
${dl([
  ['Allocations', `${r.credits.allocations.length} · ${r.credits.totals.allocatedUsd} USD`],
  ['Auto-grants', `${r.credits.autoGrants.length} · ${r.credits.totals.autoGrantedUsd} USD`],
  ['Top-up requests', `${r.credits.topupRequests.length} · ${r.credits.totals.topupRequestedUsd} USD`],
  ['Top-ups granted', `${r.credits.topupsGranted.length} · ${r.credits.totals.topupGrantedUsd} USD`],
  ['Top-ups denied', r.credits.topupsDenied.length],
  [
    'FX days live / inherited / missing',
    `${r.fx.summary.live} / ${r.fx.summary.inherited} / ${r.fx.summary.missing}`,
  ],
  [
    'FX range (USD/MYR)',
    r.fx.summary.minRate === null ? 'no rates' : `${r.fx.summary.minRate} to ${r.fx.summary.maxRate}`,
  ],
  [
    'FX discrepancies raised / resolved',
    `${r.fx.summary.discrepanciesRaised} / ${r.fx.summary.discrepanciesResolved}`,
  ],
  ['FX carry-forward alerts', r.fx.summary.carryForwardAlerts],
])}
</section>
<section aria-labelledby="h-files">
<h2 id="h-files">Files</h2>
<div class="wrap"><table>
<thead><tr><th scope="col">File</th><th scope="col" class="num">Bytes</th><th scope="col">SHA-256</th></tr></thead>
<tbody>${files}</tbody>
</table></div>
<p class="muted">manifest.json lists every file including this report. The pack hash (SHA-256 of the zip) is recorded in the audit log as evidence_pack.generated and re-checked before every download.</p>
</section>
<footer class="muted">${esc(m.privacy)}</footer>
</main>
</body>
</html>
`;
}

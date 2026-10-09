# Runbook: off-host anchoring and Verify (R2)

- **Risk:** R2, High. The in-file hash chain can be defeated by anyone who can drop the trigger and recompute.
- **Owner:** the platform architect.
- **When:** before production (§2, §3); daily (check the anchor age, §5); quarterly (an independent Verify, §6); and
  immediately when Verify fails (§7).
- **Design:** [ADR-0010](../adr/0010-off-host-anchoring.md), [architecture §5.9](../architecture.md#59-verification-and-anchoring).

## 1. What an anchor proves, and what it does not

- Every event's hash covers its header and the previous hash. The head hash at sequence `n` therefore commits to
  events `1..n`.
- An **anchor** copies `(chainId, seq, hash, time)` to a place the AOC host cannot rewrite. Later, Verify
  recomputes the chain and checks that the recomputed hash at `seq` still equals the anchored one. Any edit,
  insertion or deletion at or before `seq` breaks the match.
- An anchor proves **nothing about events after it**. A host-level attacker can rewrite unanchored events, and the
  next anchor will then faithfully record the rewritten history. **The anchor interval is the window of
  undetectable tampering.**
- **The default configuration does not mitigate R2.** `audit.anchorProvider: git` with no `audit.anchorRemote`
  only commits to a local repository on the same host. Configure §2 or §3 before production.
- **What is built** (`mod-audit`): one provider at a time (`audit.anchorProvider`: `git`, `rfc3161` or `none`);
  the nightly `audit.anchor` job at `audit.anchorAtLocalTime` (governed-config check, anchor with two retries
  30 s apart, then Verify); `aoc anchor` and `aoc verify` on demand. Anchoring **refuses** a chain that no longer
  matches the anchors already made (`anchor_mismatch`, `chain_invalid`), so a rewritten history is never
  laundered into a fresh anchor.

## 2. Git anchor (provider `git`)

1. **Create a dedicated anchor repository**, for example `aoc-anchors`. Ideally it lives under a different GitHub
   organisation or owner than the product repositories, with different admins (the CEO and one other person).
2. **Protect its default branch** with a ruleset that has no bypass actors: block force pushes, restrict deletions.
   Even the AOC host must not be able to rewrite history. Nobody else commits to it: AOC pushes its local branch
   and never merges remote changes, so any other commit on the remote makes every later push fail
   (`push_failed`).
3. **Give the AOC host a write deploy key for this repository only**, stored with the service user (mode 0600).
   It is not a credential profile. But until sessions run as their own OS user (threat model O-1), an agent can
   read it: it could push extra anchor files, which makes anchoring and Verify fail (a false alarm and a
   denial of service), though it cannot rewrite or delete history on a protected remote. Recovery needs an
   operator: remove the bogus file with a new commit on the remote, then bring the local anchor repository level
   with the remote (fetch and fast-forward) so that pushes succeed again. The history keeps both.
4. **Commit signing.** `mod-audit` signs anchor commits with OpenPGP when it is given a key id (the module
   option `gpgKeyId`, with an optional `GNUPGHOME`); Verify then rejects unsigned commits and commits signed by
   another key. **`aocd` cannot pass that option yet** (threat model O-11), so anchor commits are unsigned in the
   default build. Signing settings in the anchor repository's own git config have no effect: `mod-audit` sets
   the identity and signing flags on every commit (`commit.gpgsign=false` without a key) and runs git with hooks
   disabled. The real protection is the append-only history on the remote anyway, because a signing key would
   also live on the host.
5. **Configure aocd:**

   ```json
   {
     "audit": {
       "anchorProvider": "git",
       "anchorRepoPath": "/var/lib/aoc/anchor-repo",
       "anchorRemote": "git@github.com:<anchor-org>/aoc-anchors.git",
       "anchorAtLocalTime": "02:00"
     }
   }
   ```

6. **Optional mirror:** let the anchor remote mirror itself to a second provider (a push mirror configured on the
   remote). AOC pushes to, and verifies against, `anchorRemote` only, so check the mirror by hand (§5).

**What an anchor commit holds.** One file per anchor, `anchors/<YYYY-MM-DD>-<seq>.json`, containing
`{chainId, seq, hash, anchoredAt, previousAnchor}`, committed as `AOC Anchor <aoc-anchor@localhost>` and pushed
to `anchorRemote`. `anchor.created` records the proof reference `git:<commit>:<file>` with `signed` and `pushed`.
A failed push keeps the local commit, appends `anchor.failed {reason: push_failed}` and notifies Builders and the
Approver ("Audit anchor was not pushed off-host"): until the next successful push, that anchor is local only.

## 3. RFC 3161 anchor (provider `rfc3161`)

1. **Choose a TSA.** The default `https://freetsa.org/tsr` is a free service with no SLA: fine for development
   only. For compliance evidence, use a commercial TSA or one run by a licensed certification authority, and
   record its certificate chain.
2. **Configure** `audit.anchorProvider: "rfc3161"` and `audit.tsaUrl`. `mod-audit` hashes the anchor record into
   a time-stamp query (`openssl ts -query -sha256 -cert`), posts it to the TSA, and keeps the record, query and
   token (`.json`, `.tsq`, `.tsr`) in `<dataDir>/anchors`. `openssl` must be on the service's `PATH`.
3. **Keep every timestamp token** (`.tsr`) where the AOC host cannot delete it: for example, copy the tokens to
   the anchor repository as well, or to object storage with object lock. A token that only exists on the AOC host
   can be deleted. It cannot be forged for a past time, but a missing anchor is still lost evidence.
4. **Know what Verify checks.** It checks each token's imprint against the anchor record and rejects a TSA time
   more than 1 h from the record's `anchoredAt` (no back-dating). It checks the TSA's signature and certificate
   chain (`openssl ts -verify`) **only when a CA file is configured**, and that is a module option (`tsaCaFile`)
   that `aocd` cannot pass yet (threat model O-11). Until then Verify warns that token signatures are not
   verified, and a host-level attacker could forge a token: check tokens by hand (below) for evidence purposes.
5. **Check a token by hand:**

   ```bash
   cd <dataDir>/anchors
   openssl ts -reply -in <date>-<seq>.tsr -text                                  # the TSA time and the imprint
   sha256sum <date>-<seq>.json                                                   # must equal the imprint
   openssl ts -verify -data <date>-<seq>.json -in <date>-<seq>.tsr -CAfile tsa-chain.pem
   ```

   The imprint is the SHA-256 of the anchor record file itself (`{chainId, seq, hash, anchoredAt,
   previousAnchor}`), so the token covers the head hash and the anchoring time together.

**Both providers at once** would be the strongest option (git for availability and easy reading, the TSA for an
independently signed time), but `mod-audit` runs one provider at a time. Prefer `git` with a protected off-host
remote; choose `rfc3161` where an independently signed time matters more and its tokens are copied off the host.

## 4. Cadence

| Setting | Gives | Recommendation |
| --- | --- | --- |
| Nightly (`anchorAtLocalTime`, the spec minimum) | Up to about 24 h of unprotected events | Acceptable only during development |
| Hourly | Up to 1 h | **Production baseline** |
| After high-value events | Gates are protected within minutes | Anchor after `decision.resolved` for go-live, rollback or break-glass, and after `promotion.completed`, `rollback.executed`, `body.erased` and `config.changed` |

Hourly and event-triggered anchoring are a requested change to `mod-audit` (threat model O-11). Until they ship,
run `aoc anchor` hourly from cron. It needs the `audit.verify` permission (Builders and the Approver), so use a
dedicated user for it, run the cron job under an OS account other than the aocd service user (whose home
sessions can read today, O-1), and keep that token at mode 0600 (see
[operations](operations.md#7-running-a-job-by-hand)).

Run the nightly backup **after** an anchor, so every backup is covered ([key custody](key-custody.md#4-backups-off-host-nightly)).

## 5. Daily checks

- The Control Tower integrity panel shows the **anchor age** (`anchorAgeMs`), the **unanchored event count**, and
  `chainOk`. The anchor age must stay below the cadence plus a margin. Audit health warns `anchor_stale` once the
  newest anchor is older than 26 h, and `anchor_failed` after a failure newer than the last anchor.
- `anchor.failed` events and `anchor.missed` notifications reach Builders and the Approver. Treat a missed
  anchor as an incident, Sev-2 once the newest anchor is more than a day old
  ([incidents](incident-break-glass.md#1-severity)): fix the cause (network, deploy key, TSA outage), then run
  `aoc anchor` and confirm a new `anchor.created` with `pushed: true`.
- The remote really holds the anchors. From any machine other than the AOC host:

  ```bash
  git clone --quiet git@github.com:<anchor-org>/aoc-anchors.git /tmp/anchors && git -C /tmp/anchors log -3 --format='%h %G? %s'
  ```

  `%G?` shows the signature status (`G` = good).

## 6. Verify

**Inside AOC** (`aoc verify`, or the console; permission `audit.verify`, held by Builders and the Approver):
Verify recomputes the whole chain (`EventStore.verifyChain({atSeqs})`), including the check that every event's
indexed scope columns agree with its chained scope, and compares the recomputed hash at every anchored sequence
with the **external** record. It records `chain.verified {ok, headSeq, checked, anchorsChecked, anchorsMatched,
firstBadSeq, unanchoredTail}`. `aoc verify` exits non-zero unless the chain recomputes **and** every anchor
matches.

With an `anchorRemote`, Verify fetches the remote branch into `refs/aoc/anchor-remote/<branch>` and compares it
with the local anchor repository: an anchor missing locally, or different between the two, is a problem, and the
remote copy wins. **If the remote cannot be fetched, Verify still runs against the local copy and only warns
("anchor remote unreachable"). Treat that warning as a failed check.**

Rules that make Verify meaningful:

1. Read the anchors from the **remote** (as AOC's Verify does when it can fetch it, or from a fresh clone), or
   from the stored TSA tokens, never from the local anchor repository alone and never from `anchor.created` rows
   in the database being verified. An attacker who controls the host controls both of those.
2. Check that the anchors form an unbroken series at the expected cadence. A gap is a missing proof and must be
   explained.
3. For TSA anchors, check the token signature, the certificate chain, and that the token's time is close to the
   anchor's recorded time. An attacker who rewrote history could obtain **new** tokens, but only with current
   times. AOC checks the time and the imprint; the signature and chain only with a CA file (§3).

**Independent verification** (quarterly, and for the auditor): give the auditor a copy of `aoc.db` (the chain
tables are enough; bodies are not needed) and read access to the anchor remote. The auditor recomputes every hash
following [architecture §5.1](../architecture.md#51-the-chain-row) (canonical JSON of the header fields, SHA-256,
genesis `SHA-256("aoc-genesis:" + chainId)`), and compares them with the anchors. The evidence pack
(`evidence_pack.generated {chainOk, …}`) records a chain check for its date range, but it compares anchors with the
chain's own `anchor.created` events, not with the off-host records (threat model O-29, gap G-42). A pack does not
replace Verify: run `aoc verify` when you generate one, and attach its output.

## 7. When Verify fails (Sev-1)

1. **Freeze.** Pause promotions, rollbacks and break-glass. Keep managed sessions running only if the CEO agrees.
2. **Preserve.** Copy `aoc.db`, `aoc.db-wal`, `bodies.db` and the logs to read-only storage, and compute their
   SHA-256. Do not run a projection rebuild or any repair.
3. **Locate.** `firstBadSeq` and the last matching anchor bound the tampered range. Compare the events in that
   range with the newest backup taken **before** it, and with the GitHub audit log.
4. **Report.** Notify the CEO and record the incident outside AOC as well (the AOC log is the thing in doubt).
   Raise the post-incident change record once AOC is trusted again.
5. **Recover**, by CEO decision only: restore from the newest backup whose chain verifies against every anchor up
   to its time. Record the lost or altered range in the incident record. Then find out how the attacker got write
   access to `aoc.db` (threat model T-2, T-13, O-1).

Never "fix" a broken chain by recomputing it. The broken state is the evidence.

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

## 2. Git anchor (provider `git`)

1. **Create a dedicated anchor repository**, for example `aoc-anchors`. Ideally it lives under a different GitHub
   organisation or owner than the product repositories, with different admins (the CEO and one other person).
2. **Protect its default branch** with a ruleset that has no bypass actors: block force pushes, restrict deletions.
   Even the AOC host must not be able to rewrite history.
3. **Give the AOC host a write deploy key for this repository only**, stored with the service user (mode 0600).
   It is not a credential profile and never reaches a session.
4. **Commit signing.** Configure an SSH or GPG signing key for the service user's anchor commits
   (`git config gpg.format ssh`, `user.signingkey …`, `commit.gpgsign true` inside the anchor repo). The signature
   attributes each commit to the AOC host. The real protection, though, is the append-only history on the remote,
   because the signing key also lives on the host.
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

6. **Optional mirror:** push to a second remote with another provider for redundancy. Verify accepts either.

The anchor-commit file layout is defined by `mod-audit`. Each commit must carry at least the chain id, the
sequence, the head hash and the time.

## 3. RFC 3161 anchor (provider `rfc3161`)

1. **Choose a TSA.** The default `https://freetsa.org/tsr` is a free service with no SLA: fine for development
   only. For compliance evidence, use a commercial TSA or one run by a licensed certification authority, and
   record its certificate chain.
2. **Configure** `audit.anchorProvider: "rfc3161"` and `audit.tsaUrl`.
3. **Keep every timestamp token** (`.tsr`) where the AOC host cannot delete it: for example, commit the tokens to
   the anchor repository as well, or put them in object storage with object lock. A token that only exists on the
   AOC host can be deleted. It cannot be forged for a past time, but a missing anchor is still lost evidence.
4. **Check a token by hand:**

   ```bash
   openssl ts -reply -in anchor-<seq>.tsr -text            # shows the time and the message imprint
   openssl ts -verify -in anchor-<seq>.tsr -digest <imprint-hex> -CAfile tsa-chain.pem
   ```

   The imprint is the digest that `mod-audit` submits for the head hash. Its exact construction is part of the
   anchor record format.

**Using both providers** is the strongest option: git for availability and easy reading, the TSA for an
independently signed time.

## 4. Cadence

| Setting | Gives | Recommendation |
| --- | --- | --- |
| Nightly (`anchorAtLocalTime`, the spec minimum) | Up to about 24 h of unprotected events | Acceptable only during development |
| Hourly | Up to 1 h | **Production baseline** |
| After high-value events | Gates are protected within minutes | Anchor after `decision.resolved` for go-live, rollback or break-glass, and after `promotion.completed`, `rollback.executed`, `body.erased` and `config.changed` |

Hourly and event-triggered anchoring are a requested change to `mod-audit` (threat model O-11). Until they ship,
run `aoc audit anchor` hourly from cron, under a dedicated identity whose token is stored with mode 0600 (see
[operations](operations.md#7-running-a-job-by-hand)).

Run the nightly backup **after** an anchor, so every backup is covered ([key custody](key-custody.md#4-backups-off-host-nightly)).

## 5. Daily checks

- The Control Tower integrity panel shows the **anchor age** (`anchorAgeMs`), the **unanchored event count**, and
  `chainOk`. The anchor age must stay below the cadence plus a margin.
- `anchor.failed` events and `anchor.missed` notifications reach the Approver. Treat a missed anchor as a P2
  incident: fix the cause (network, deploy key, TSA outage), then run `aoc audit anchor` and confirm a new
  `anchor.created`.
- The remote really holds the anchors. From any machine other than the AOC host:

  ```bash
  git clone --quiet git@github.com:<anchor-org>/aoc-anchors.git /tmp/anchors && git -C /tmp/anchors log -3 --format='%h %G? %s'
  ```

  `%G?` shows the signature status (`G` = good).

## 6. Verify

**Inside AOC** (`aoc audit verify`, or the console; permission `audit.verify`, held by Builders and the Approver):
Verify recomputes the whole chain
(`EventStore.verifyChain({atSeqs})`) and compares the recomputed hash at every anchored sequence with the
**external** record. It records `chain.verified {ok, headSeq, checked, anchorsChecked, anchorsMatched,
firstBadSeq}`.

Rules that make Verify meaningful:

1. Read the anchors from a **fresh clone of the remote**, or from the stored TSA tokens, never from the local anchor
   repository on the AOC host and never from `anchor.created` rows in the database being verified. An attacker who
   controls the host controls both of those.
2. Check that the anchors form an unbroken series at the expected cadence. A gap is a missing proof and must be
   explained.
3. For TSA anchors, check the token signature, the certificate chain, and that the token's time is close to the
   anchor's recorded time. An attacker who rewrote history could obtain **new** tokens, but only with current
   times.

**Independent verification** (quarterly, and for the auditor): give the auditor a copy of `aoc.db` (the chain
tables are enough; bodies are not needed) and read access to the anchor remote. The auditor recomputes every hash
following [architecture §5.1](../architecture.md#51-the-chain-row) (canonical JSON of the header fields, SHA-256,
genesis `SHA-256("aoc-genesis:" + chainId)`), and compares them with the anchors. The evidence pack
(`evidence_pack.generated {chainOk, …}`) records the same check for its date range.

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

# Runbook: encrypted backups and restore (R6, G-21)

- **Risk:** R6, High. The event log, the body store and the keys are a single point of total data loss.
- **Owners:** the platform architect (runs backups and restores), the CEO (second custodian of the keys, decides
  retention and every production restore).
- **When:** once before real data lands (§2), daily (§4), quarterly (restore drill, §6), and after a disaster (§5).
- **Related:** [key custody](key-custody.md) (the KEK, escrow, crypto-shred), [anchoring](anchoring.md) (off-host
  anchors and Verify), [operations](operations.md).

## 1. What a backup holds, and what it never holds

`mod-audit` takes one encrypted backup a day (`audit.backupAtLocalTime`, default 02:30 — after the 02:00 anchor, so
every backup is covered by an anchor). Each run writes one file, `aoc-backup-<UTC time>-<id>.aocbk`, to
`audit.backupDir`:

| In the backup | How |
| --- | --- |
| `aoc.db` (chain and read models) | `VACUUM INTO` on a separate read-only connection, in a worker thread: a transactionally consistent, compacted copy taken while aocd keeps serving. Free pages holding scrubbed read-model text are not copied |
| `bodies.db` (encrypted bodies, wrapped data keys) | The same, **after** `aoc.db`: a body commits before its event, so every event in the copy has its body |
| `blobs/` | Exactly the blobs the `bodies.db` copy references (ciphertext, as stored) |
| `anchors/` | RFC 3161 tokens kept in the data dir (self-verifying; signed by the TSA) |
| `evidence/` | Frozen evidence packs |

**Never in a backup:** the KEK (`master.key` or `keys.masterKeyFile`), the bootstrap token, the credential profiles
file, session directories, or anything else in the data dir. The archive format only admits the paths above.

The whole set is sealed with **AES-256-GCM under a backup key that is not the KEK** (aocd refuses to run a backup if
they are equal). `aoc.db` holds decrypted copies of some text, so without this the backup would be personal data in
clear. A backup alone is useless without the backup key; its bodies are useless without the KEK. Keep the two keys
with different custodians.

Every run is recorded in the chain:

- `backup.completed {backupId, file, bytes, sha256, keyId, kekId, headSeq, headHash, files, aocDbBytes,
  bodiesDbBytes, blobs, blobBytes, skippedBlobs, bodiesMissing, copied, pruned, retained}` — sizes, hashes and key
  fingerprints only (no paths, no personal data). `sha256` is the hash of the encrypted file, so anyone can check an
  off-host copy **without** the key. `keyId` names the backup key that decrypts it; `kekId` names the KEK its bodies
  need. Neither reveals a key.
- `backup.failed {backupId, stage, reason}` (detail in the encrypted payload) and a `backup.missed` notification to
  the Approver and Builders.

## 2. Set up (before real data lands)

1. **Generate the backup key** on the AOC host, as root, outside the data dir, the backup dir and the KEK's directory:

   ```bash
   umask 077
   install -d -m 0700 -o aoc -g aoc /etc/aoc-backup
   openssl rand -hex 32 > /etc/aoc-backup/backup.key
   chown aoc:aoc /etc/aoc-backup/backup.key && chmod 0400 /etc/aoc-backup/backup.key
   ```

   aocd refuses a backup key that is world-accessible, lives inside `dataDir` or `backupDir`, sits in the same
   directory as `keys.masterKeyFile`, or equals the KEK (`backup.failed` reasons `backup_key_exposed`,
   `backup_key_misplaced`, `backup_key_is_kek`). A systemd credential (`LoadCredentialEncrypted=`) works as well;
   point `backupKeyFile` at it.
2. **Escrow the backup key** like the KEK ([key custody §2](key-custody.md#2-generate-the-kek)) but with a
   **different custodian set** (for example the CEO and a third officer, while the platform architect holds the KEK
   escrow). Record the key fingerprint printed by `aoc backup now` (`Backup key …`) with the escrow.
3. **Choose the off-host target.** Either mount storage the AOC host cannot delete at `backupDir` (WORM / object
   lock), or keep `backupDir` local and ship each file with `backupCopyCommand`, which runs without a shell after
   every backup; `{file}` is replaced by the file's path:

   ```json
   {
     "audit": {
       "backupDir": "/var/lib/aoc/backups",
       "backupKeyFile": "/etc/aoc-backup/backup.key",
       "backupAtLocalTime": "02:30",
       "backupRetentionDays": 35,
       "backupCopyCommand": ["rclone", "copy", "{file}", "offsite:aoc-backups"]
     }
   }
   ```

   The copy command gets aocd's environment **minus** `AOC_*`, `ANTHROPIC_*` and `CLAUDE_CODE_OAUTH*`; give it its
   own credentials (an rclone config, an instance role) with write-only, no-delete rights. A non-zero exit is
   recorded as `copied: false` plus `backup.failed {stage: copy}`; the local file is kept.
4. **Retention** (`backupRetentionDays`, default 35) is a CEO decision tied to the PDPA erasure promise (threat model
   O-12, gap P-03): an erasure is complete only when every backup taken before it has expired. aocd prunes
   `backupDir` only; give the remote target the same lifecycle rule.
5. **Check it works:** `aoc anchor`, then `aoc backup now`. Compare `sha256sum` of the off-host copy with the
   printed SHA-256. `aoc backup list` shows the schedule and the newest backups.

Agents can never touch `backupDir` or `backupKeyFile`: both are part of the self-modification boundary's protected
audit state.

## 3. What runs every night

1. 02:00 `audit.anchor`: anchor the head off-host, then Verify.
2. 02:30 `audit.backup`, serialised with anchoring and Verify:
   1. load and check the backup key;
   2. snapshot `aoc.db`, then `bodies.db`, into `<dataDir>/backup-staging/` (same trust zone as the live data; removed
      afterwards, and cleared at the start of every run in case a crash left it behind);
   3. check the snapshot is a prefix of the live chain (`snapshot_mismatch` otherwise — treat it as an integrity
      incident, [anchoring §7](anchoring.md#7-when-verify-fails-sev-1));
   4. pack and seal everything into `.aoc-backup-….partial`, fsync, rename to the final name;
   5. run `backupCopyCommand`, prune past retention, append `backup.completed`.

A manual `aoc backup now` (permission `audit.backup`, held by the Approver only: a Builder's `audit.verify` and
`audit.view` do not reach it, and Builders can still list the backups) runs the same steps; a second manual run within
10 minutes is refused (429), so repeated full copies cannot fill the disk.

## 4. Daily checks

`GET /api/audit/health` (also `health()` of the `audit` service, which the Control Tower reads) carries a `backup`
section and these warnings:

| Warning | Meaning | Action |
| --- | --- | --- |
| `backup_not_configured` | No `backupKeyFile`: nothing is backed up | §2 before real data lands |
| `backup_never` / `backup_stale` | No backup yet, or none in the last 26 h | Check `job_runs` and the newest `backup.failed`; run `aoc backup now` |
| `backup_failed` | The newest backup step failed | Read `backup.failed.reason` (below), fix, run `aoc backup now` |
| `backup_not_copied` | The newest backup did not reach off-host storage | Fix the copy target, then run `aoc backup now` |

| `backup.failed` reason | Fix |
| --- | --- |
| `backup_key_unreadable` / `backup_key_exposed` / `backup_key_misplaced` / `backup_key_is_kek` | §2 step 1 |
| `staging_failed`, `backup_dir_unavailable`, `write_failed` | Disk space and permissions on the data volume and `backupDir` |
| `snapshot_failed` | Read the payload detail (Approver); usually disk space |
| `snapshot_mismatch` | Integrity incident: the database changed behind aocd's back |
| `copy_failed` | The copy command's credentials, network or target |
| `prune_failed` | Permissions in `backupDir`; old backups are now kept past retention (PDPA) |
| `aborted` | aocd stopped during the run; the next run starts clean |

Alert as well when a backup is much smaller than the previous one (`backup.completed.meta.aocDbBytes`; the chain is
append-only, so `aoc.db` should only grow, while `bodies.db` and blobs shrink after erasures).

## 5. Restore after a disaster

Production restores are a CEO decision. Restore **into an empty data dir with aocd stopped**; `aocd restore` refuses
to touch a directory that holds anything.

1. **Get the pieces, two-person rule:** the newest `.aocbk` file (check its SHA-256 against the off-host listing or
   the `backup.completed` record), the backup key from its custodians, the KEK from escrow. Never put the KEK in the
   data dir.
2. **Restore and check** (the anchor remote is cloned fresh, read-only):

   ```bash
   node dist/bin/aocd.mjs restore --config /etc/aoc/aoc.config.json \
     --from /mnt/offsite/aoc-backup-20261009T183005Z-0ABCDEF1.aocbk \
     --backup-key-file /media/custody/backup.key --kek-file /media/escrow/kek \
     --data-dir /var/lib/aoc/data --require-anchor
   ```

   Everything is decrypted into a staging directory next to the target and checked first: the manifest; the KEK
   (its fingerprint, then every live data key must unwrap); the whole hash chain; every body against its chained
   hash; every blob; and the chain against the off-host anchors (git: a fresh clone of `audit.anchorRemote`, or
   `--anchor-remote` / `--anchor-repo`; RFC 3161: the tokens restored with the backup). Only a backup that passes is
   moved into place; otherwise the target stays empty and the command exits 1. A backup whose chain disagrees with an
   off-host anchor is never installed — take an older one.
3. **Read the report.** `anchors n/n` must match. A `recovery point` warning means off-host anchors exist **newer**
   than the backup: events between the backup head and that seq existed and are lost. Record the range in the
   incident (outside AOC).
4. **Put the KEK where aocd loads it** (`keys.masterKeyFile`, outside the data dir). The command warns if the
   configured location is missing or holds a different KEK. Starting without the KEK in place is refused ("refusing
   to generate a new KEK": aocd never generates one beside restored data, production or not), and starting with a
   *different* KEK would fail every append with a body. If the local anchor repository was lost, clone it again from
   the anchor remote into `audit.anchorRepoPath`.
5. **Start aocd and run `aoc verify`** before any other work. Re-issue session and observer ingest tokens.
6. **After a lossy restore** (step 3 showed a recovery point), the off-host anchors of the lost range describe a
   history that no longer exists: Verify keeps reporting them and anchoring refuses to anchor over a mismatch. Keep
   that anchor series read-only as evidence, and, by CEO decision recorded in the incident, start a new anchor series
   (a new anchor repository and remote) for the restored chain. Never rewrite or delete the old anchors.

## 6. Quarterly restore drill

Follow §5 on an **isolated** host with the newest backup, the escrowed KEK and the backup key, a read-only clone of
the anchor remote, and a drill config with `fx.enabled: false`, `audit.anchorProvider: none`, no
`decisions.webhookUrl`, no `backupCopyCommand` and no claude binary. Pass `--require-anchor`. Record the recovery time
(start of the restore to `aoc verify` passing) and the recovery point (age of the backup, and any newer anchors), and
attach both to the next evidence pack. Destroy the drill copy and return both keys to their custodians.

## 7. Rotating the backup key

Generate a new key (§2), escrow it, point `backupKeyFile` at it and run `aoc backup now`. Backups made with the old
key still need it — `backup.completed.meta.keyId` names the key of every backup — so keep the old key in escrow
until the last of them has passed retention, then destroy it. Rotate yearly, and immediately if the key may have
leaked (re-take a backup with the new key at once, and treat old off-host copies as exposed to whoever holds the old
key **and** the KEK).

## 8. File format (for recovery without AOC code)

```
"AOCBKUP1" | u32 BE header length | header JSON {format: "aoc-backup/1", cipher, kdf, chunk: 65536, salt, keyId, backupId, createdAt}
frames:     u8 flags (1 = final) | u32 BE ciphertext length (≤ 65536) | ciphertext | 16-byte GCM tag
frame key:  HKDF-SHA256(ikm = backup key, salt = header.salt, info = "aoc-backup/1 frame key", 32 bytes)
nonce:      flags byte | 3 zero bytes | u64 BE frame counter (from 0);  AAD: the exact header bytes
plaintext:  records "u32 BE length | record JSON"; {t: "file", path, size} is followed by size content bytes;
            the last record is {t: "end", manifest: {chainId, headSeq, headHash, kekId, files: [{path, bytes, sha256}], …}}
```

A stream that ends without a final frame is truncated; a frame that fails authentication was altered or was sealed
with a different key. `keyId` is the first 16 hex chars of `SHA-256("aoc-backup-key-id:" ‖ key)`.

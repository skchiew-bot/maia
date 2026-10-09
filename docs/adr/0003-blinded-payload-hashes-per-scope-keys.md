# 0003. Blinded payload hashes and per-scope encryption keys

- Status: Accepted
- Date: 2026-10-09
- Deciders: Platform architect
- Spec: AOC-SPEC-003 §7 (uploads: encrypted body store, hashes only in the chain), §13

## Context

- Store only payload hashes and metadata in the chain. Bodies (file contents, prompts, discovery captures, intake
  text and media) go in a separate encrypted store, "so a slipped secret or PDPA data can be erased by destroying
  the key while the chain stays valid" (§13).
- A plain SHA-256 of a short or guessable value (a person's name, an IC number, "yes") can be recovered by
  dictionary attack. If the chain kept such a hash, erasing the body would not erase the data.
- Erasure must be granular. One requester's ticket, one session that leaked a secret, or one person's profile must
  be erasable without touching anything else.
- Intake video can be up to 200 MB, which does not belong in a database row.
- The chain is in clear text forever, so free text must be kept out of it structurally, not only by convention.

## Decision

1. **Blinded hash.** `payloadHash = SHA-256(blind + ":" + canonicalJSON(payload))`, where `blind` is 16 random bytes
   stored **only inside the encrypted body** (`{b: blind, p: payload}`). The chain commits to the body without
   revealing it, and after erasure the hash cannot be brute-forced.
2. **Envelope encryption with per-scope keys.** A 32-byte KEK wraps one DEK per scope and generation
   (`<scope>#<generation>`) with AES-256-GCM. Bodies and blobs are sealed with the DEK under AES-256-GCM, and the
   AAD (`aoc-body:<eventId>`, `aoc-blob:<blobId>`, `aoc-dek:<keyId>`) binds each ciphertext to its own record.
3. **Scope selection.** `bodyScope` defaults to the event's `sessionId`, then `ticketId`, then `projectId`, then
   `global`. Writers set it explicitly when the data belongs to another subject. Intake uses the ticket. Identity
   data must use the user id.
4. **Crypto-shred.** `eraseScope` destroys every DEK generation of the scope, deletes its ciphertext rows and blob
   files, truncates the WAL, lets projectors scrub derived text (`onErase`), and appends `body.erased`. Erasure is
   itself a governed, audited action (`audit.erase` permission, optionally tied to a decision).
5. **Strict meta.** Each event's `meta` schema is `strict` (unknown keys are rejected) and limited to ids, enums,
   numbers, booleans, hashes and short machine labels. Free text, file contents, prompts, personal data and
   secrets go only in `payload`.

## Consequences

- **Good:** erasure without breaking or rewriting the chain. The chain alone reveals nothing about a body. Bodies are
  tamper-evident (`verifyBody`). A leaked secret in one session is shredded without touching other sessions.
- **Bad:** once erased, a body's content can never be proven again. That is intended: the chain still proves that
  an event of that type, actor and time existed. Evidence packs show `[erased]`.
- **Bad: scope choice is permanent.** It is made per event type at design time. A wrong scope (especially
  `global`, which is shared) makes granular erasure impossible later, so review it with every new event type.
- **Bad: backups.** Backups taken before an erasure still contain the destroyed DEKs. Erasure is complete only when
  those backups expire. The backup retention period is part of the PDPA erasure promise
  ([key custody](../runbooks/key-custody.md#6-crypto-shred)).
- **Bad: KEK compromise** exposes every body that has not been erased. Custody of the KEK is a defined procedure
  (R6, [key custody](../runbooks/key-custody.md)).
- **Bad: meta discipline.** Meta can never be erased. Strict schemas catch unknown keys but not a badly chosen
  field, such as a free-text "label". Every new event type gets a meta review.

## Implementation status (integration commit `e97e53e`)

Erasure is complete in the live databases: `aoc.db` runs with `secure_delete = ON`, its WAL is truncated after each
erasure, and the knowledge layer's FTS5 index is merged (threat model O-24, review finding F-08). aocd's own backups are
sealed under a key that differs from the KEK and are pruned after `audit.backupRetentionDays` (35): an erasure is
complete only when the last older backup has expired. Whether an erasure must reference an approved request is still
open (O-28, gap G-47).

## Alternatives rejected

| Alternative | Why rejected |
| --- | --- |
| Unblinded `SHA-256(payload)` in the chain | Brute-forceable for low-entropy personal data, so erasure would be cosmetic |
| HMAC with one global secret | Erasing one record would mean rotating the key for everything; one key compromise breaks every record |
| SQLCipher or full-disk encryption only | Protects data at rest, but cannot erase one subject's data |
| Bodies inside the chain, "redacted" by rewriting | Breaks the hash chain and every external anchor |
| Deleting rows without crypto | WAL pages, free pages and backups keep the plaintext, and there is no way to show the deletion was complete |

## References

- `packages/kernel/src/store/event-store.ts` (`write`, `verifyBody`, `eraseScope`),
  `packages/kernel/src/store/body-store.ts`, `packages/kernel/src/crypto.ts`
- `packages/contracts/src/events/define.ts` (`meta()` is strict, `payload()` passes through)
- [architecture.md §5.3 to §5.5](../architecture.md)

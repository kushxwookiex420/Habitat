# Ax identity and memory continuity

Ax is defined independently of any provider. This document describes what is implemented, what is
proven by tests, and what is still missing.

## Identity vs intelligence

- `ax-identity.mjs` holds the identity core in code: name, role, principles, voice and continuity
  guarantees. It exposes a digest computed only from that core.
- `createAxIdentity().snapshot({ provider, model })` returns `identity` and `intelligence` side by
  side with `coupled: false`. The digest is identical under OpenRouter, a local model or no provider at
  all, which is what "provider independence" means here in checkable terms.
- The durable record is written to memory project `ax`, key `identity.core`, on bridge initialization.
  `status()` reports `persistent` only when a stored record exists **and** its digest matches the code
  identity; a rewritten record is reported `not_yet_persisted` rather than believed.
- Owner directives (preferences, goals, decisions) are separate memory entries with
  `provenance.source: "owner"`. `setDirective` refuses a non-owner source, so an agent cannot install a
  standing instruction for itself.
- Deletion is owner-only and versioned in the memory repository. The identity core itself is not
  deletable through the directive path.

## Memory kinds and provenance

Already implemented in `ax-memory.mjs` / `d1-ax-memory-repository.mjs`: kinds
`verified_fact | claim | assumption | hypothesis | decision | preference | goal | status | risk`,
provenance sources `owner | ax | import | system`, confidence 0–1, versioned compare-and-set writes,
append-only revisions, credential refusal and soft deletion. Memory context ranks entries for planning
and clearly separates verified from unverified records.

## Export and recovery

`ax-memory-backup.mjs`:

- `exportMemory({ repository, project })` returns a portable document with active entries, their
  provenance/confidence/tags/version, bounded revision history and a `digest` over the entries.
- `verifyBackup(backup, { project })` checks schema, project, shape and digest **before** any write.
- `restoreMemory({ repository, backup })` replays entries through the repository's own `put`, so
  versioning and credential refusal still apply. It is idempotent (identical entries are `unchanged`),
  refuses to overwrite a locally newer version, and reports conflicts and refusals instead of
  overwriting them.
- `retentionReport({ repository, project, olderThanDays })` lists candidates and performs no deletion.

A restore into a fresh database reproduces the source digest exactly, which is the checkable form of
"memory recovered".

## Retention and deletion

Retention is a report, not an automatic purge. Deletion requires an owner actor through
`repository.remove`, which keeps a revision so the removal is auditable. An automatic purge policy is
deliberately not implemented yet.

## Evidence

- 8 identity tests and 5 backup tests, plus the existing memory suite: provider switch keeps the digest
  and directives; the record persists across a new instance; non-owner directives and deletes are
  refused; tampered or credential-bearing backups are refused with zero writes; restore is idempotent;
  a locally newer value is not overwritten.
- `/system/status` publishes identity name, digest, persistence, provider independence and directive
  count, and nothing provider- or secret-specific. Its addition leaves routes and other components
  byte-identical.

## Not yet done

- Memory still has no automatic summarisation or forgetting policy; retention is manual by design.
- Decision history exists as memory entries, not as a dedicated queryable timeline.
- Learning is limited to writing verified run outcomes; no evaluation of which memories improved later
  outcomes.
- Acceptance test C (swap a real provider end to end, with memory and task history) still needs a
  deployed environment; the module-level proof is complete.

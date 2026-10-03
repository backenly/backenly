# The maintenance ladder, run against production

Recorded 2026-09-16. The fixture project this was measured on is disposable and
has since been destroyed, so these numbers are the durable record.

The exercise answers one question: does the expand/contract ladder work on a
real production database, through the real executor, under every gate — and can
it be undone. It is not evidence about detection. The finding was created by
`scripts/maintenance-acceptance-fixture.ts` and labelled as such; Phases 1–3
were not exercised.

## What ran

Project `e4e0d7db-3d38-41a4-84c1-ffe08e7194cf`, plan `42cefed814b40c16`,
executor image `backenly-runtime@sha256:b155953078ca…`, mutations enabled only
in the operator's shell.

The subsystem: `sessions.status` (`CHECK status IN ('active','archived','pending')`)
duplicated by `sessions.legacy_state`. 80 rows. The ladder consolidates onto a
new `lifecycle_state` holding `upper(status)`.

| Rung | Tier | Outcome |
|---|---|---|
| `add_structure` | 1 | added `sessions.lifecycle_state text` — table oid 44820 unchanged, **80 rows preserved** |
| `carry_constraints` | 2 | `lifecycle_state IN {ACTIVE, ARCHIVED, PENDING}`, **derived** from `status {active, archived, pending}` under `upper` |
| `dual_write` | 2 | trigger `bkn_dw_sessions_lifecycle_state` installed |
| `backfill` | 2 | dispatched to BackgroundJob; **80 rows updated over 1 batch**, through RLS |
| `verify` | 0 | **80 compared, none disagreed** |
| `switch_readers` | 2 | **9 Backenly-authored readers switched; 3 consumer classes cannot be enumerated** and still read `sessions.status` |
| `contract` | 3 | **`awaiting_human`** — never executed |

The executor halted at `awaiting_background_work` after dispatching the backfill
and resumed only once the job had actually completed, rather than running
`verify` against rows nothing had touched.

## The reader switch, and undoing it

Three hashes of `AiFunction.generatedCode`, in order:

| Point | `codeSha256` | reads `status` | reads `lifecycle_state` |
|---|---|---|---|
| before the switch | `a99ecbe4f30f8af4` | yes | no |
| after the switch | `020adfff944c0364` | no | yes |
| after the revert | **`a99ecbe4f30f8af4`** | yes | no |

The revert restored the bytes recorded in the ledger by the switch — not
regenerated code that happens to behave the same. The restored hash is
identical to the pre-switch hash.

## The observation window told the truth twice

On the silent fixture it returned `insufficient_sample`: *"0 request(s) before
and 0 after, below the 20 needed to compare. Nothing was demonstrated either
way."* Zero traffic demonstrates nothing, and it said so rather than reporting
health.

Only after synthetic traffic was induced (40 healthy before the switch, 40
failing after, all marked `/acceptance-fixture/induced`) did it return
`regressed` — *"error rate rose from 0.0% to 100.0%"* — with `shouldRevert:
true`, and 9 readers were reverted with 0 failures.

That proves the mechanism. It says nothing about whether switching readers is
safe in general, which only real traffic can answer.

Phase 8 reported `insufficient_sample` throughout: *"1 incident(s) before the
repair, below the 3 needed to tell an improvement from a quiet week."* Also the
correct answer, and left as-is.

## Consent behaved as designed

Each `add_structure` changed the catalog, which changed the catalog
fingerprint, which changed `planVersion` — and the approval bound to the old
version stopped applying. Every resume needed a freshly read plan version and a
new approval, refusing in between with *"plan version is X, not Y … one of those
moved."* That is the property the whole design rests on.

## Seven defects this found, all of them silent

None surfaced as an error. Each was caught by a gate, or by a report
contradicting itself.

1. **`sanitizeError` stopped redacting** connection-string passwords — `\b` in a
   regex literal had decayed to U+0008. Messages are logged *and* persisted.
2. **`verify-analytics-posture` stopped detecting** a boolean `autocapture`, same
   cause, reporting a clean repo.
3. **The fixture's reader detection** reported every reader as reading nothing,
   same cause — in the artifact that produces the reader evidence.
4. **Five RLS-blind reads**: `reconcile`, `backfill`, the covariation probe,
   `add_structure`'s row-count safety check, and the fixture's own seeding
   check. Each counted 0 rows on a full table. The `add_structure` one is the
   sharpest: it compared 0 before with 0 after and agreed every time, which is
   also what a destroyed table looks like.
5. **`policy_overlap` counted RESTRICTIVE policies**, so the platform's own
   `bkn_pgrst_soft_delete` raised false fragmentation on every project, and the
   diagnosis could never confirm anything anywhere.
6. **`split_brain_writers` vetoed every diagnosis.** Unconfirmable by design, it
   held a confirmed `duplicated_lifecycle_state` at 0.714 against a bar of 0.85
   — a cap no evidence could ever lift.
7. **Expand/contract weakened the schema.** The target column got no constraint,
   so `contract` would have dropped a constrained column and left an
   unconstrained one. Fixed by `carry_constraints`, which derives the target's
   domain by applying the transform to the source's and refuses unless the
   binding says the same thing.

The lesson worth keeping: when one of these checks returns "clean", ask what it
would return if it were blind.

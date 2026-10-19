# Governed change recovery

Internal architecture. The user-facing promise is one sentence:

> Backenly protects governed changes with recovery checkpoints and can
> automatically recover failed changes when recovery is proven safe. Risky
> recovery remains human-controlled.

Everything below is how that sentence is kept true. Code: `lib/changes/`.

## The principle

A governed change has a recoverable lifecycle. Recovery is not a separate
product: it is what happens to a change that fails, or that a person later
wants undone. The console reports outcomes ("Applied · Verified", "Recovered
automatically · Production healthy"); the machinery (restore points, plans,
checks, SQL) is behind **View details**.

Three authorities, never mixed:

| Authority | May | May not |
|-----------|-----|---------|
| Coding agent (MCP key) | request changes, request a restore, read outcomes | approve anything, skip or weaken verification, touch checkpoints or the audit trail, change governance settings without a person |
| Backenly control plane | checkpoint, verify, recover when recovery is proven lossless, escalate | recover when it cannot prove safety, report success it has not verified |
| A person (admin on the project) | approve a risky restore, restore manually, approve an agent's request | — |

## Lifecycle

`BackendChange.status`, moved only by `lib/changes/lifecycle.ts`:
compare-and-set on the current status, one append-only event per transition.

```
applying ─┬─> verifying ─┬─> healthy ───────────────┬─> restoring ─> restored
          │              ├─> unverified (could not   │                (by a person)
          │              │    check: never recovered │
          │              │    automatically)         └─ (restore record is its own
          │              └─> verification_failed ─┐      change: reapply = restore it)
          ├─> failed (nothing applied)            │
          └─> partially_applied ──────────────────┤
                                                  ├─> recovering ─┬─> recovered
                                                  │               └─> recovery_failed
                                                  └─> awaiting_approval ─┬─> recovering
                                                                          └─> kept (a person declined)
recovery_failed / an interrupted applying ─> manual_intervention_required ─┬─> recovering
                                                                          └─> kept
kept ─> recovering (a person restores it later)
```

`healthy`, `unverified` and `kept` mean "this change is in effect and nothing
is pending"; `kept` also says it failed its checks and a person chose to keep
it, which clears it from the queue and lets automatic recovery resume for the
project. A recovery that ran but whose result Backenly could not confirm is
never `recovered`.

## Checkpoints

Taken under the project's change lock before the first statement
(`lib/changes/ledger.ts`), proportionate to the change's risk:

| Risk class | Example | Protection |
|------------|---------|------------|
| additive | create table/column/index/constraint | catalog restore point |
| transforming | rename, retype, nullability, default | restore point; a retype also keeps the original values and the values it produced |
| destructive | drop table/column | restore point; the data moves into the change's vault (`lib/changes/preserve.ts`) in the same transaction as the drop |
| data rewrite | backfill, normalise, split, cast with data | restore point; the pre-image (`_dm_backup_*`) and the post-image of the rewritten columns, captured inside the migration's own transaction |

The checkpoint is resource-typed (`checkpoint.resources.database`) so a change
spanning database, functions and auth policies can be represented; today only
the database resource is captured and recovered, and nothing claims otherwise.

Integrity: the restore point, result state and footprint are hashed when the
change closes, and every vault table records its row count and checksum when it
is filled. A restore re-checks both before it plans anything; a mismatch makes
the restore point unusable, and it is shown as unavailable, never as available.

## Protected verification

`lib/changes/verify.ts` runs after every governed change, inside the change
lock, before the change is reported. Its checks are defined by the control
plane and take nothing from the request: no argument, setting or statement an
agent sends can skip, narrow or reinterpret them.

- **Expected effects.** Each step the change reported as done is checked
  against the catalog: a created table exists, a dropped column is gone, a
  rename happened. A step that said "done" and did nothing is a silent failure.
- **No collateral damage.** Views, functions, triggers or constraints that
  disappeared without the change naming them (a `CASCADE` side effect).
- **Protections kept.** Row-level security not disabled or un-forced, credential
  tables not exposed to API roles, API grants on existing tables not revoked,
  the end-user auth table's required columns intact. A person's explicit
  decision (dashboard or approval) may weaken RLS; an agent's request may not.
- **Usable.** No invalid index left behind; every surviving touched table can be
  planned against.

Three-valued, like `lib/core/fix-verification.ts`: `confirmed`, `contradicted`,
or `inconclusive` when a check could not run. Only `contradicted` starts
recovery; an inconclusive check leaves the change `unverified` and says so.

## Recovery plans

`lib/changes/recovery.ts` builds a plan for "the state before change N":

1. **Ancestry.** Every table the change touched must look exactly as the change
   left it. A later change to the same table, or a change made outside Backenly,
   is a conflict that names what to restore first. Unrelated later changes are
   untouched: a restore only acts on its own footprint.
2. **Statements.** `lib/changes/plan.ts` (pure) orders the reverse statements.
3. **Impact.** `lib/changes/impact.ts` asks the one question that decides whether
   the restore is safe: *would any data written since the change stop being
   available to the application?*
   - rows in a table the restore removes;
   - values in a column the restore removes, other than the column's default;
   - values updated since a retype or a data rewrite (those rows keep their
     current value; only rows unchanged since get their original back);
   - values that would not survive the reverse cast;
   - rows written since that the previous schema cannot hold (a restored
     `NOT NULL` column they have no value for).
   Nothing is ever deleted: what leaves the application moves into the
   restore's own vault. But "kept in a vault" is not "available", so any impact
   makes the plan **needs approval**, and the dialog says exactly what and how
   many.
4. **Proof.** The statements run in a transaction that is rolled back.

| Plan safety | Meaning | Who may run it |
|-------------|---------|----------------|
| `lossless` | no conflicts, impact empty, proof passed | Backenly automatically (after a failed verification), or a person |
| `needs_approval` | impact non-empty, proof passed | a person, who has seen the impact |
| `blocked` | conflict, or the proof failed against today's data | nobody until the named cause is resolved |
| `unavailable` | restore point expired, purged, or failed its integrity check | nobody; the console does not offer it |

Execution re-proves the plan: tables are locked `ACCESS EXCLUSIVE` first, the
impact is computed again under the lock, and if it is worse than what the
person approved (or non-empty for a lossless restore) nothing runs. Then the
statements, the independent check against the restore point, and protected
verification of the result.

A plan's strategy is `reverse_migration` (the plan above, with vault restores
and value restores) or `manual` (no plan can be built, and a person decides). A
change that fails before changing anything leaves nothing to recover and is
recorded as `failed`. Project snapshots (Database → Snapshots) stay a separate
restore a person runs: the engine neither takes nor uses them. Point-in-time
recovery is infrastructure-level and not offered here.

## Automatic recovery

```
change applied → protected verification
  confirmed     → healthy
  contradicted  → verification_failed → plan
                    lossless       → recovering → recovered (verified) | recovery_failed
                    otherwise      → awaiting_approval (existing approvals inbox)
```

It runs in the same change lock as the change, so no other change can land in
between. A recovery that fails stops: no retries, the evidence stays, and the
change becomes `manual_intervention_required`. While any change of the project
needs a person, Backenly takes no further automatic recovery action there: a
new failure waits for approval too, until that person restores or keeps the
stuck change.

A recovery waiting for approval is an ordinary request in the existing
approvals inbox (`lib/mcp/approvals.ts`): tool `revert_schema_change`, the
change id, and exactly the impact Backenly measured. Approving runs it (admin
only), checked again under lock against what was approved; declining keeps the
change (`kept`). A restore or keep from the console answers the request.

## Manual restore

From the change's ⋯ menu, **Restore previous state**. The restore is itself a
recorded change with its own checkpoint, so the state it replaces is protected
first; **Reapply this change** restores that checkpoint. Internally that is a
recovery of a recovery; the console never presents it as one.

A restore keeps what a reapply needs the way a change does. Every column it
converts back or puts original values on gets a keyed image in the restore's
vault: each value before the restore and, beside it, the value the restore
left. A column it brings back from a vault gets an image of the values it put
there. Reapplying then puts the change's values back only on rows nobody has
touched since the restore, and sets aside, for a person to approve, only what
was written after it, never the values the restore itself put back.

## Concurrency and idempotency

- One change at a time per project: a PostgreSQL advisory lock held from the
  checkpoint through verification and any automatic recovery
  (`lib/changes/lock.ts`). A second change waits, bounded, then is refused.
- Every change records its parent (the change before it). A restore checks the
  live state against the change's result state, so it never acts on a state it
  did not produce.
- Recovery is claimed by compare-and-set with a lease. A duplicate request
  finds it claimed and returns the outcome. A process that dies mid-recovery
  leaves the lease to expire; the reconciler then reads the catalog and records
  what actually happened (restored and verified, not restored, or neither →
  manual intervention). It never re-runs a recovery on its own.

## Audit

`backend_change_events` is append-only, enforced by a database trigger: no
update, no delete except with the project. `backend_changes` rows cannot change
their identity, attribution or evidence once written, and status can only move
along the lifecycle above. Each event carries the principals
(`lib/principal`): who requested, who authorised, who executed. Recoveries and
restores are also written to the audit log as `ROLLBACK_CHANGE_*` rows, so the
Autonomy page's activity feed and its "Rolled back" count include them; a
reapply (`CHANGE_REAPPLIED`), a change kept as it is (`CHANGE_KEPT`) and a
recovery waiting for a person (`CHANGE_RECOVERY_*`) appear in the feed without
counting as rollbacks.

## Regions and residency

A project's schema lives in its region's database (`lib/data-plane/regional.ts`),
so everything a change does to the project's data happens there: the change
lock and the connection it holds (`lib/changes/lock.ts`), the catalog read for
the checkpoint and for verification, every vault, and the restore itself. A
region this process has no connection to is refused with
`REGION_NOT_CONFIGURED`; nothing falls back to the home database, where the
schema is not. The SQL recorder is installed on the region's own client, so a
regional change's statements are captured where they are sent.

The change records themselves are platform rows in the home region. For a
project kept elsewhere they keep names, counts, the footprint, the catalog
structure (the same class of record as the workspace schema snapshots) and
each check's outcome, and withhold the SQL that ran, step summaries, error
text and the request as written (`lib/changes/residency.ts`, after
`lib/data-plane/residency.ts`). View details says the SQL stays in the region.
The data a change kept is never on a platform row: it is in the vault, a schema
in the project's own database.

Region qualification (`scripts/qualify-region.ts`) restores a governed change
from the console and requires the restore to come back verified.

## What is not automated

- Changes outside the database (functions, auth providers, storage) are not in
  the checkpoint yet.
- Row data written by the application is not versioned; only data a change
  itself removed or rewrote is kept.
- A restore crossing a later change to the same table is refused, not merged.
- A change interrupted by a crash is reconciled to `manual_intervention_required`
  with its footprint; a person decides.
- A restore that today's rows would break (a dropped CHECK, UNIQUE, foreign or
  primary key, with rows written since that it would refuse) is never offered:
  its preview is `blocked`. Run anyway, it fails inside its own transaction and
  nothing changes.

## The other ways back, and why they stay

Restoring the state before a change is the only schema undo. The routes that
undid changes another way (moving the active-graph pointer, re-creating what a
saved version named, replaying a snapshot's DDL, the archive restores) answer
410 and point here (`lib/changes/retired.ts`). Two ways back remain, on
purpose, outside the ledger:

- **Project snapshots** (Database → Snapshots) restore the whole database from a
  backup, a person's disaster-recovery step. A table it reshaped no longer
  matches what a change left, so restoring that change is refused as a conflict,
  as for any change made outside Backenly, rather than run over it.
- **The repair loop's policy recovery** (`restore_policies`, declared in
  `lib/authority/action-classes.ts`) puts a table's row-level-security policies
  back when the repair's own verifier rejects its change, guarded against
  overwriting a later change and written to the audit log. Moving it onto the
  ledger needs a recovery mode for a change the ledger verified but a repair
  rejected; until then it is the one recovery that runs beside it.

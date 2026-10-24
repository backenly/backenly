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

## One history

A project has one history, for the whole backend, at **History** in the
console (`/app/projects/:id/changes`; `/history` is a permanent redirect left
from an older page). A change that adds a table, a bucket and an environment
variable is one entry, restored as one. The schema is one part of it; the rest
is recorded by `lib/changes/resources`, one adapter each:

| Part | Items | Comes back exactly | Never comes back |
|------|-------|--------------------|------------------|
| database | tables, columns, constraints, indexes, policies, triggers, grants to the API roles, views, functions, enums, domains | everything the catalog holds | data written since (see Recovery plans) |
| auth | sign-in settings, OAuth providers, the SMTP sender, email templates | settings and templates; a provider's client id, scopes, switch | a client secret, the SMTP password |
| storage | buckets and their settings | settings; an empty bucket the change created goes again | a bucket holding files written since stays; a bucket removed with its files |
| functions | functions and schedules: code, trigger, Power switch | all of it, under the same id | — |
| webhooks | webhooks and table triggers | targets, events, conditions, switches | a signing secret |
| env | environment variables | descriptions; a variable the change added goes again | a value |
| keys | API and agent keys | permissions, limits, expiry; a key the change created is revoked | a revoked or rotated key |
| integrations | stored keys, which integrations are switched on | switches; a key the change stored is removed | a stored key; a switch turned off with its key stays off with it |

A credential never comes back, whoever asks (Cloudflare's rule for its own
tokens): what is kept of one is a digest of its hash or ciphertext, or the IV
that identifies its encryption, so a restore can tell that it changed and
cannot put it back. A restore that would leave one as the change
made it says so and needs a person who approves exactly that; a change that only
did what cannot be undone (revoking a key) offers no restore at all.

Not in the history, on purpose:

- **Data.** Rows the application wrote are never rewound by a restore; only
  data a change itself removed or rewrote is kept and put back. Snapshots are
  the disaster-recovery copy of the data.
- **Runtime state.** A key's last-used stamp and rate-limit window, how a
  function's last run went (`status: 'error'`), integration key verification.
  None is a decision anyone made, and comparing them would make every restore
  look blocked.
- **Backenly's derived plumbing.** The row-event capture trigger and its
  outbox, presence (`PLATFORM_OBJECTS`, `lib/changes/catalog.ts`). Each is
  derived from other rows by its own sync, which a restore asks to run again.
  Realtime's trigger is a person's choice and is in the history.
- **What belongs to something else.** The project's public anon key (one with
  `Project.anonKey`), a preview branch's keys (they end with the branch), a
  table's generated endpoints (they follow the table: `generatedEndpointsFollow`).

Every write to a recorded row goes through a governed change
(`governedChange`, `withGovernedChange`, or an action in `GOVERNED_ACTIONS`).
`scripts/assert-history-writes.ts` fails CI on one that does not, reading the
recorded models from the adapters themselves; a write that is not a change says
why in a `// history:` comment, and a comment that names `GOVERNED_ACTIONS (X)`
or `governed by fn` is checked against the code.

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
| destructive | drop table/column | restore point; the data moves into the change's vault (`lib/changes/preserve.ts`) in the same transaction as the drop; a table that a view, a function or another table's default still reads is not dropped, and the refusal names them |
| data rewrite | backfill, normalise, split, cast with data | restore point; the pre-image (`_dm_backup_*`) and the post-image of the rewritten columns, captured inside the migration's own transaction |

The checkpoint is resource-typed: `checkpoint.database` holds the catalog,
`checkpoint.resources` every item of the rest of the backend the change touched,
as it was (`resultState.resources`, as the change left it). A secret is kept as a
digest of its hash or ciphertext, or as the IV of its encryption, never its
value. The record's `resources`
column says which parts it touched, for History's filters.

Integrity: the restore point, result state and footprint are hashed when the
change closes, and every vault table records its row count and checksum when it
is filled. A restore re-checks both before it plans anything; a mismatch makes
the restore point unusable, and it is shown as unavailable, never as available.

Retention: a vault is kept for the plan's restore window plus a grace week, then
dropped (`lib/changes/retention.ts`). A vault that anything outside it still
reads is kept past that and named in the log instead: dropping it with
`CASCADE` would take the reader from the live schema without a word.

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
4. **Proof.** The statements run in a transaction that is rolled back. Inside
   it, nothing outside the restore's vault may read what the restore moved in:
   a view over a table the change created, a policy on another table that
   reads it, a default drawing from its sequence. PostgreSQL tracks those by
   oid, so they would follow the table and keep working against the vault
   (`lib/changes/dependents.ts`). Each one is a conflict like a later change
   to the same table: the plan is `blocked`, names it, and names the later
   change that made it, when one did.

The rest of the backend is planned beside the schema (`assessResources`): an
item that changed since the change is a conflict that names it and the later
change, like a table; an item a credential rule keeps is listed for approval.
Its part is applied in one platform transaction that commits only once the
schema's restore has, and is compensated if the schema's COMMIT fails, so the
two never land apart. It is verified afterwards by reading every item back.

| Plan safety | Meaning | Who may run it |
|-------------|---------|----------------|
| `lossless` | no conflicts, impact empty, proof passed | Backenly automatically (after a failed verification), or a person |
| `needs_approval` | impact non-empty, proof passed | a person, who has seen the impact |
| `blocked` | conflict, or the proof failed against today's data | nobody until the named cause is resolved |
| `unavailable` | restore point expired, purged, or failed its integrity check | nobody; the console does not offer it |

Execution re-proves the plan: tables are locked `ACCESS EXCLUSIVE` first, the
impact is computed again under the lock, and if it is worse than what the
person approved (or non-empty for a lossless restore) nothing runs. Then the
statements, the value checks and the check that nothing outside the vault
reads it, all before COMMIT, and after it the independent check of the result
against the restore point. A restore is not put through the change checks of
`verify.ts`: what it must produce is known exactly (the restore point), and it
is held to that.

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

From the change's ⋯ menu in History, **Restore previous state**. The restore is itself a
recorded change with its own checkpoint, so the state it replaces is protected
first; **Reapply this change** restores that checkpoint. Internally that is a
recovery of a recovery; the console never presents it as one.

Reapply is offered only for the latest restore of a change, from the change
itself, and only for a change protected verification confirmed when it was
made. Reapplying marks the change healthy again on the strength of that
verification, so a change that failed its checks, could not be checked or
failed part-way is asked for again instead, and checked again. A restore of a
reapply is not offered either: it would undo the change while the change stayed
reported in effect.

A restore keeps what a reapply needs the way a change does. Every column it
converts back or puts original values on gets a keyed image in the restore's
vault: each value before the restore and, beside it, the value the restore
left. A column it brings back from a vault gets an image of the values it put
there. Reapplying then puts the change's values back only on rows nobody has
touched since the restore, and sets aside, for a person to approve, only what
was written after it, never the values the restore itself put back.

**Restore to this point** (`lib/changes/range.ts`) returns the backend to how
it was right after one change: everything made since is undone, newest first,
each step an ordinary restore with its own proof, record and reapply. A restore
made after the point, of a change made before it, is undone too (the change is
reapplied), since it was in effect at the point; a change and its own restore
after the point are left alone; a change only a credential rule keeps is named
and left. It runs a step only when its restore is lossless and stops at the
first that needs a person or cannot run, saying which; what it restored before
that stays restored, and running it again continues. The dialog lists the
steps before anything runs, and the server refuses (`STALE_PAGE`) if the list
changed since.

A published version marks History at the time it was published, and **Restore**
on a version (History or Deploy) is restore to that point: the last change
before it was published. Reached in full, the version is also recorded as the
current one. Deploy's old rollback moved that record and nothing else.

An agent asks for the same thing with `deploy { action: "rollback", version }`.
Backenly measures it as the console would (`describeVersionRestore`): a version
that does not exist, or that nothing has changed since, is answered at once;
otherwise the request is parked with Backenly's list of the changes it would
undo, never the agent's own words. A project admin approves it in the Review
Queue, and approving runs exactly that list (`restoreToVersion`), by the
approver, or nothing if the history changed since. The executor's own
`ROLLBACK_DEPLOY` runs nothing and says how to ask.

## Concurrency and idempotency

- One change at a time per project: a PostgreSQL advisory lock held from the
  checkpoint through verification and any automatic recovery
  (`lib/changes/lock.ts`). A second change waits, bounded, then is refused.
- Every change records its parent (the change before it). A restore checks the
  live state against the change's result state, so it never acts on a state it
  did not produce.
- An agent's restore request (`deploy { action: "revert_change" }`) proves the
  restore before it is queued, and proving locks the tables it touches, so a
  project takes six such requests a minute from its agents.
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
Autonomy page's activity feed shows them; its "Rolled back" count counts undone
fixes (`HEALTH_FIX_ROLLED_BACK`) only. A reapply (`CHANGE_REAPPLIED`), a change
kept as it is (`CHANGE_KEPT`) and a recovery waiting for a person
(`CHANGE_RECOVERY_*`) appear in the feed as well.

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

- Credentials are never brought back, and data written since is never
  rewound (One history, above).
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

Restoring the state before a change, one at a time or to a point, is the only undo. The routes that
undid changes another way (moving the active-graph pointer, re-creating what a
saved version named, replaying a snapshot's DDL, the archive restores) answer
410 and point here (`lib/changes/retired.ts`). One way back stays a separate
restore, on purpose, though it is recorded in the history:

- **Project snapshots** (Database → Snapshots) restore the whole database from a
  backup, a person's disaster-recovery step. The restore is an entry in History
  (`kind: 'snapshot_restore'`, by the person who asked) that History does not
  undo: restoring an earlier snapshot does. A table it reshaped no longer
  matches what a change left, so restoring that change is refused as a conflict
  rather than run over it, and Restore to this point stops at it.

The repair loop's policy recovery is on the ledger now (`recoverRejectedRepair`,
mode `repair`): a change the ledger verified but the repair's own verifier
rejected is restored like any other, by Backenly, and recorded. Autonomous
maintenance (`lib/autonomy/maintenance`) records each rung that changes the
backend, and its undo, as a change by Backenly, without automatic recovery:
undoing a rung is that subsystem's decision, against what the rung left.

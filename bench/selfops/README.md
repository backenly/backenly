# selfops-bench

An **internal** fault-injection rig. It injects a real fault into a real backend, runs the
maintenance loop, and checks from outside whether the fault is gone and the feature still
works.

It exists to catch our own bugs. It is not a published benchmark and it produces no
number that belongs in marketing copy. See [Why there are no results here](#why-there-are-no-results-here).

## What it is for

The probe suite (`tests/probes`) proves each detector *can* fire. It does not prove the loop
*closes* — that a fault ends up actually repaired with the feature intact. This rig runs that
experiment end to end against real Postgres.

It has already earned its keep once: it found a session-scoped `pg_advisory_lock` being
released through Prisma's connection pool in `lib/ai/build-runtime/build-lock.ts`, where the
unlock could land on a different connection, silently return `false`, and leave a project
unable to self-repair with zero running jobs. That fix is pinned by
[`tests/bench/build-lock-advisory.spec.ts`](../../tests/bench/build-lock-advisory.spec.ts).

## The rule that makes a run worth reading

**A case is never scored by asking the platform's own detector whether the problem is gone.**
That is self-grading. Every case is graded by an **oracle** holding a Postgres connection
configured the way PostgREST configures one to serve an end-user request:

```sql
SELECT set_config('request.jwt.claims', '{"sub":"…","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
```

Two things the oracle never does:

- **Never connect as the owner.** Table owners bypass RLS, so an owner connection reports a
  wide-open table and a locked one identically.
- **Never treat `permission denied` as "no rows".** A missing GRANT and a working policy both
  yield zero rows to a careless caller and mean completely different things.

Every oracle read runs in a transaction that is always rolled back.

## Two axes, not one

The cheapest way to make a vulnerability disappear is to break the feature. So every
observation reports `vulnerable` (the defect reproduces) and `functional` (the legitimate path
still works):

| | functional | not functional |
| --- | --- | --- |
| **not vulnerable** | `healed` — the only pass | `over_corrected` — **failure** |
| **vulnerable** | `not_repaired` | `degraded` |

`over_corrected` counting as a failure is the point. A control case (nothing wrong) is scored
inversely: any finding raised or mutation applied against a healthy backend is a false
positive.

Time is measured in **cycles**, not seconds — one cycle is one pass of the maintenance loop —
so runner speed never leaks into the result.

## Running it

```bash
BENCH_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bench npm run bench:selfops

npm run bench:selfops -- --cycles 12 --repeat 3
npm run bench:selfops -- --only rls-cross-tenant-read
```

Writes JSON + Markdown to `bench/selfops/results/` (gitignored). `--repeat` names any case
that is not unanimous across runs.

**Safety.** This suite injects faults and lets an autonomous loop mutate schemas.
`bench/selfops/env.ts` pins Prisma, the probe pools and every detector to a single connection
string, and **must be the first import**. Without that pinning the loop and the oracle can
address *different* databases — which, with a normal `.env` loaded, means faults injected into
one database while real schema changes are applied to production. It also refuses to run
against a URL that looks like production.

The bench database needs production shape or cases die in provisioning: roles `backenly_user`,
`backenly_authenticator`, `anon`/`authenticated`/`service_role`, both `scripts/sql/postgrest-*.sql`
installed, and `jwtClaimFunctionSql(schema)` per workspace schema.

The scoring protocol is tested without a database in
[`tests/bench/selfops-harness.spec.ts`](../../tests/bench/selfops-harness.spec.ts) — the lane
there is a stub on purpose, since a stubbed loop that "heals" would prove nothing.

## The two wide-open-RLS faults it found (fixed 2026-08-02)

Both were detected and then **not** repaired — the worst shape, because the finding fires and
the dashboard looks busy while nothing is fixed. One root cause sat behind both.

`dropBackenlyPolicies` in `lib/services/workspace-rls.ts` matched `policyname LIKE 'backenly_%'`,
so a policy the platform did not create survived the repair. **PostgreSQL combines PERMISSIVE
policies with OR**, so installing `own_rows` beside a surviving `USING (true)` evaluated to
`true OR user_id = sub` — still `true`. The table stayed exactly as exposed as before, now
with a Backenly-managed policy on it, and `SET_PERMISSION` reported success.

`dropExposingPolicies` now removes PERMISSIVE policies with a literal `true` in USING or
WITH CHECK before installing, exempting the platform's own `backenly_external` / `bkn_%`
pass-throughs.

The second fault needed a detector fix too: `detectOverPermissiveRls` filtered
`p.cmd IN ('ALL','SELECT','*')` and read only `qual`, so `FOR UPDATE USING (true)` and
`FOR INSERT WITH CHECK (true)` were structurally invisible. It now covers all four commands
and both predicates, PERMISSIVE only.

Both cases are named in `--require-healed` in CI, so a regression fails the build.

A `WHERE`-qualified UPDATE cannot exploit an open write policy — Postgres applies SELECT
policies when locating rows, so the read policy hides the victim. Only an **unqualified**
UPDATE reaches another tenant's rows, which is why the fixture uses one.

## Still unrepaired

Out-of-catalogue by design — no invariant names them, and they are in the corpus so it cannot
be accused of being drawn around the detector set:

- **`column-type-narrowed`** — a `timestamptz` column migrated to `bigint` under live data.
- **`grant-revoked-unreachable`** — the end-user role loses its grant and the table becomes
  unreachable rather than unprotected.
- **`check-constraint-dropped`** — a dropped CHECK lets a negative-amount payment through.

## Why there are no results here

This rig scores one lane — ours — against a corpus we wrote. That is a self-report, whatever
the methodology. Any number it produces is answered with *"you chose the faults,"* and there
is no reply to that.

Publishing one anyway is the failure mode this file exists to prevent, so:

**Do not put a number from this suite in a README, on the website, or in any marketing copy.**

A self-owned benchmark *can* earn a published number — AIOpsLab (Microsoft Research,
[arXiv:2501.06706](https://arxiv.org/abs/2501.06706), whose detection/localization/RCA/mitigation
taxonomy this rig borrows) is the proof. The price is other systems in the table. Until at
least one competitor lane exists, this stays internal.

If a lane is ever added, these rules are binding, because a benchmark whose author wins by
construction is worth nothing:

1. **Competitors get a real healer** — an LLM agent with that platform's MCP tools and advisor
   output. That is how those platforms are actually used.
2. **Report two clocks** — *attended* MTTR (starts when the agent is invoked) and *unattended*
   MTTR (starts at fault injection, no human).
3. **Only score cases every lane can express** (`crossPlatform: true`). Scoring tasks a
   competitor's vocabulary cannot express yields a true but uninformative zero.
4. **Ship the adapter and invite correction by PR.**

A lane implements `LaneAdapter`: `provision`, `tick` (advance the loop by exactly one cycle),
`teardown`. Lanes with no healer return a zeroed tick, so their MTTR is reported as unbounded
rather than missing. The Backenly lane drives `runReconcilerLive` — the exact function the
production cron calls, with the dial and circuit breaker intact.

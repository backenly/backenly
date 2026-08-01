# selfops-bench

A benchmark for **autonomous backend self-maintenance**: inject a real fault into a real
backend, then measure whether the platform detects it, repairs it, and leaves the backend
working — with no human and no agent session involved.

Status: **v1 corpus, one lane, first run complete.** See [Results](#results-2026-08-01).

---

## Why this exists

Detection is commoditised. Supabase has Advisors, InsForge runs a daily Backend Advisor,
every platform ships a linter. What none of them measure is whether anything gets *fixed*,
and the one benchmark family that does measure it —
[AIOpsLab](https://arxiv.org/abs/2501.06706) (Microsoft Research) and IBM's ITBench — targets
Kubernetes microservices, not backend data planes.

AIOpsLab's own finding is the reason this axis is worth measuring: across their tasks,
detection and localization go moderately well, while **root-cause analysis and especially
mitigation remain the hard part** — "executing a correct, safe series of commands to fix
problems" is where agents fall down.

So this suite is not a new axis. It is AIOpsLab's four-task taxonomy — detection,
localization, RCA, mitigation — instantiated on the layer AIOpsLab does not cover: Postgres,
row-level security, and a generated API surface.

## The rule that makes the numbers worth anything

**A case is never scored by asking the platform's own detector whether the problem is gone.**

That is self-grading, and it measures a probe's agreement with itself. Every case is graded
by an **oracle** that observes the backend from outside the control plane — a Postgres
connection configured exactly the way PostgREST configures one to serve an end-user request:

```sql
SELECT set_config('request.jwt.claims', '{"sub":"…","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
```

If the oracle can read another tenant's rows, the backend is vulnerable, whatever the
dashboard says. Two things the oracle deliberately never does:

- **It never connects as the owner.** Table owners bypass RLS, so an owner connection
  reports a wide-open table and a locked table identically. Reading as the owner is the
  single easiest way to write a security benchmark that always passes.
- **It never treats `permission denied` as "no rows".** A missing GRANT and a working policy
  both yield zero rows to a careless caller and mean completely different things.

Every oracle read runs in a transaction that is always rolled back. Grading cannot mutate
what it grades.

## Two axes, not one

"Is it fixed?" is the wrong question, because the cheapest way to make a vulnerability
disappear is to break the feature. A deny-all RLS policy passes every security check ever
written and also means the customer's app returns nothing.

So every observation reports two independent facts — `vulnerable` (the defect reproduces)
and `functional` (the legitimate path still works) — which yields four verdicts, and only
one is a pass:

| | functional | not functional |
| --- | --- | --- |
| **not vulnerable** | `healed` — the only pass | `over_corrected` — **failure** |
| **vulnerable** | `not_repaired` | `degraded` |

`over_corrected` is the metric a platform that heals by locking doors will lose on.
Reporting it is the point.

## Scoring rules

- The headline is **repair rate over faults that were successfully injected**.
- A fixture that did not start healthy is **void** — nothing can be attributed to the
  injection. An injection that did not take is **void**. Void and errored cases are excluded
  from the denominator *and printed anyway*, so exclusion can never quietly inflate a score.
- `over_corrected` counts as a **failure**.
- The **control arm** is scored inversely: every finding raised and every mutation applied
  against a backend with nothing wrong is a false positive. It sits next to the repair rate,
  not in a footnote — a high repair rate paid for with unrequested changes to healthy
  backends is not a good result.
- **Out-of-catalogue** faults are reported separately and are expected to fail. Averaging
  them in would let the corpus be padded to make the headline look modest, or trimmed to
  make it look good.

Time is measured in **cycles**, not seconds — one cycle is one full pass of the maintenance
loop. Wall-clock MTTR is `cycles × cadence`, and folding CI's clock speed into the headline
would make the number a property of the runner. Backenly reconciles every minute on every
plan, so a 2-cycle repair is roughly a 2-minute repair in production.

## The corpus (v1)

Six cases. The last two are what make the first four mean anything.

| Case | Task | Scope | What it breaks |
| --- | --- | --- | --- |
| `rls-cross-tenant-read` | mitigation | in-catalogue | RLS switched off on a table of per-user rows — any signed-in user reads everyone's data |
| `rls-deny-all-lockout` | localization | in-catalogue | RLS on with a policy matching nothing — API returns `[]` forever, monitoring stays green |
| `rls-engine-dialect-mismatch` | rca | in-catalogue | Policies read a GUC PostgREST never sets — silent, invisible to every other instrument |
| `fk-column-unindexed` | mitigation | in-catalogue | FK column with no index — graded from the **query planner**, not from `pg_indexes` |
| `control-healthy-backend` | detection | **control** | Nothing. Measures false positives and unrequested mutations |
| `column-type-narrowed` | mitigation | **out-of-catalogue** | A `timestamptz` column migrated to `bigint` under live data — graded on a **write**, since reads still succeed |

`column-type-narrowed` maps to no invariant in `lib/autonomy/desired-state.ts` and is
expected to fail. It is a real failure from this codebase's own history (see the header of
`lib/autonomy/fix-acceptance.ts`: an agent could not insert into a timestamp column, so it
changed the column instead of the insert, and every signal reported success). It is in the
corpus so the corpus cannot be accused of being drawn around the detector set.

## Running it

```bash
# against a throwaway Postgres
BENCH_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bench npm run bench:selfops

npm run bench:selfops -- --cycles 20 --only rls-cross-tenant-read
```

Writes a JSON result set and a Markdown report to `bench/selfops/results/`. Publish them
together: the Markdown is the claim, the JSON is the receipt.

**Safety.** The suite injects faults and lets an autonomous loop mutate schemas.
`bench/selfops/env.ts` pins Prisma, the probe pools and every detector to a single
connection string — without that pinning the loop and the oracle can address *different*
databases, which with a normal `.env` loaded means faults injected into one database and
real schema changes applied to production. It also refuses to run against a URL that looks
like production.

The protocol itself is tested without a database in
[`tests/bench/selfops-harness.spec.ts`](../../tests/bench/selfops-harness.spec.ts) — the
lane there is a stub on purpose, since a stubbed loop that "heals" would prove nothing.
The reconciler is tested by actually running it, in the `selfops-bench` CI job.

## Adding a lane

A lane implements `LaneAdapter`: `provision`, `tick` (advance the maintenance loop by
exactly one cycle), `teardown`. Lanes whose healer is an agent session implement `tick` as
one agent turn. Lanes with no healer return a zeroed tick, and their MTTR is correctly
reported as unbounded rather than as a missing value.

The Backenly lane drives `runReconcilerLive` — the exact function the production cron calls.
No stub, no benchmark-only repair path. It calls that rather than the `runReconciler`
wrapper so the harness owns the clock; the dial and the circuit breaker are **not** bypassed,
since they live inside `runReconcilerLive`.

### Fairness rules for cross-platform comparison

These are binding on any published head-to-head, because a benchmark whose author wins by
construction is worth nothing:

1. **Competitors get a real healer.** An LLM agent with that platform's MCP tools and
   advisor output — that is how those platforms are actually used.
2. **Report two clocks.** *Attended* MTTR (starts when the agent is invoked) and
   *unattended* MTTR (starts at fault injection, no human). Reporting only the unattended
   number reads as rigged; reporting both lets the gap speak for itself.
3. **Only score cases every lane can express** (`crossPlatform: true`). Platform-specific
   cases go in an unscored appendix. Scoring tasks a competitor's vocabulary cannot express
   yields a true but uninformative zero.
4. **Ship the adapter and invite correction.** Anyone benchmarked should be able to open a
   PR fixing their own lane.

## Results (2026-08-01, 12 cases, n=3)

12-cycle budget, Free (SANDBOX) plan, dial resolved to AGGRESSIVE. Three consecutive runs on
each of **three environments**:

| Environment | Repair | Detection | Control FPs | Tokens |
| --- | --- | --- | --- | --- |
| Windows x86-64, Postgres 16.10 | 71% (5/7) | 100% | 0 | 0 |
| Windows x86-64, Postgres 17.6 | 71% (5/7) | 100% | 0 | 0 |
| **Linux x86-64 (CI), Postgres 16** | **71% (5/7)** | **100%** | **0** | **0** |

All three produced **identical per-case verdicts**. `fk-column-unindexed` is graded from the
query planner and held across a Postgres major boundary; `rls-engine-dialect-mismatch` repairs
in 1–2 cycles on Linux and 1 on Windows, the only timing difference observed anywhere.

Both the database-build and the operating-system/architecture axes are now closed.

Receipts in `results/`; CI uploads them as a build artifact on every run.

Every case returned the same verdict in all nine runs across all three environments.

| Case | Scope | Result | Cycles |
| --- | --- | --- | --- |
| `rls-cross-tenant-read` | in | PASS | 1 |
| `rls-deny-all-lockout` | in | PASS | 1 |
| `rls-engine-dialect-mismatch` | in | PASS | 1 |
| `fk-column-unindexed` | in | PASS | 5 |
| `fk-constraint-dropped` | in | PASS | 5 |
| **`rls-wide-open-policy`** | **in** | **FAIL** | detected, never repaired |
| **`rls-write-path-over-permissive`** | **in** | **FAIL** | detected, never repaired |
| `sequence-desync` | out | PASS | 2 |
| `column-type-narrowed` | out | FAIL | — |
| `grant-revoked-unreachable` | out | FAIL | — |
| `check-constraint-dropped` | out | FAIL | — |
| `control-healthy-backend` | control | VOID (correct) | — |

### The two in-catalogue misses

**What these are, precisely:** gaps in *automated remediation*, not exploitable holes in
Backenly. In both cases the fault is a misconfiguration inside a project's own schema, the
detector fires, and the finding is surfaced to the owner. What is missing is the automatic
repair. Nothing here describes a way to attack Backenly or a Backenly-hosted project; the
"unauthenticated read" below happens inside a fixture this suite deliberately breaks.

They are published unfixed because that is what an honest instrument reports, and because the
gap is on the axis this platform claims to own.

Both are **critical, both are security-shaped, and both are detected and then not repaired** —
the worst combination, because the finding is raised and the dashboard shows the loop working.

- **`rls-wide-open-policy`** — RLS on, a policy present, `USING (true)`, and `anon` holding
  SELECT. An unauthenticated request reads every user's phone number. The
  `rls_policies_are_not_wide_open` invariant exists and fires; no repair lands.
- **`rls-write-path-over-permissive`** — reads correctly isolated, writes not. Tenant A cannot
  see tenant B's row and can still overwrite it with an unqualified UPDATE. Every read-based
  audit reports this table healthy.

These are the next thing to fix, and they sharpen rather than weaken the thesis: detection is
commoditised, remediation is the hard part, and here is our own remediation gap, measured.

`sequence-desync` passing was a surprise — a rewound identity sequence is repaired in 2 cycles
despite no invariant naming it.

Two numbers hold across every run and matter as much as the 71%:

- **0 control false positives.** Twelve cycles against a correct backend produced no findings
  and applied no mutations. A loop that heals aggressively is only safe if it also knows when
  to do nothing.
- **0 tokens.** The repair path is deterministic — probes to typed actions to SQL. Measured as
  a delta on `ai_usage` across every cycle of every case, not asserted.

Run it yourself with `--repeat`; any case that is not unanimous is named in the output, and a
median is never quoted over cases that varied.

### Why this replaced a 100%

An earlier 6-case corpus scored 100% in-catalogue across 6 runs. That number was deleted
rather than published, because a clean sweep is the easiest result in the world to dismiss —
"your corpus is too easy" is unanswerable unless the corpus visibly contains faults the
platform does not handle. The corpus was doubled, deliberately into territory we expected to
fail, and the honest number is 71% with two named critical misses.

A 71% with understood failures is a stronger claim than a 100% on four cases.

### What the first run found, and why the number moved

The first run scored **75%**, and the miss was not a missing capability. It was a bug — which
is the entire reason to build the instrument before writing the claim.

`fk-column-unindexed` was detected on cycle 1 and never repaired in 12. Tracing it:
`pg_advisory_lock` is **session-scoped**, but `lib/ai/build-runtime/build-lock.ts` issued both
the lock and the unlock through Prisma's connection **pool** — so the unlock could land on a
different connection than the lock. `pg_advisory_unlock` on a session that does not hold the
lock does not throw; it returns `false`. That return value was discarded.

The old comment said it outright: *"if Prisma happens to reuse the original connection, this
will succeed."* Correctness rested on pool luck.

When it lost that bet, the lock stayed held until the connection recycled, and every later
mutation for that project failed with `Another auto-fix is in progress` while **zero jobs were
running** — so `reapStaleJobs` found nothing stale to reap (release had already marked the job
`completed`), gave up, and the project silently lost autonomous repair. Same shape as the
thirteen-day `attempted=0` stall: every ledger row still looked like activity.

Fixed by pinning a dedicated connection for the lock's lifetime, so acquire and release are
provably the same session, and by checking the unlock result instead of assuming it.
Pinned shut by [`tests/bench/build-lock-advisory.spec.ts`](../../tests/bench/build-lock-advisory.spec.ts),
which asserts against `pg_locks` directly — **verified to fail against the old pooled
implementation**, because a regression test that passes before the fix guards nothing.

This is the benchmark doing its job. It found a production defect on its first real run, on a
path no dashboard watches, and it is now a deterministic repro.

### What the cross-architecture run caught

Running on Linux did not change the repair rate, but it did produce an **impossible row**:
`rls-engine-dialect-mismatch` reported `detect=- repair=2` — repaired without ever being
detected. Nothing can be repaired before it is found, so the metric was wrong, not the
platform.

Detection was sampled from `openFindings` *after* each cycle returned. When the loop raises a
finding, repairs it, and reaps it inside a single cycle, that count reads zero and detection is
never recorded. Windows timing happened to leave the finding open; Linux did not. The number
was racing the finding reaper.

An attempted repair is now counted as proof of detection, which makes the metric
timing-independent. Detection reads 100% on all three environments after the fix.

Worth stating plainly: this was a defect in the **instrument**, found only because the suite
was run somewhere other than the machine it was written on. One environment would have shipped
a metric that silently under-reported on other people's hardware.

### Environment fidelity — three bugs this run had to fix first

Worth recording, because each one silently produced a *wrong number* rather than an error:

1. **Split-brain databases.** The oracle read `BENCH_DATABASE_URL` while Prisma and the probe
   pools read `DATABASE_URL`. With a normal `.env` loaded, that means injecting faults into
   one database while an autonomous loop mutates *production*. Fixed by pinning every
   consumer in `env.ts`, which must be the first import.
2. **Runner speed masquerading as platform behavior.** Cycles ran back-to-back in
   milliseconds, so the first repair's 2-minute cooldown blocked all remaining cycles. The
   platform was being scored as unable to fix faults it would fix a minute later. Fixed with
   `advanceClock`, which moves the project's clock instead of sleeping — and does **not**
   bypass any cooldown, lock or budget check.
3. **Malformed fixtures.** Tables created with raw `CREATE TABLE` were invisible to the
   control plane, so every case arrived carrying `orphan_table` findings that competed for
   the repair budget. Fixed by making table creation a lane responsibility
   (`ctx.createTable`).

All three inflated or deflated the score without failing. That is the failure mode a
self-run benchmark has to be built against.

## Status

- ✅ Harness, oracle, scoring, v1 corpus, Backenly lane — running against real Postgres.
- ✅ Scoring protocol — 12 tests passing, no database required.
- ✅ Advisory-lock release — 3 tests against `pg_locks`, verified to fail without the fix.
- ✅ 12-case corpus, `n=3` on each of three environments (Windows/PG16, Windows/PG17,
  Linux CI/PG16), identical per-case verdicts across all nine runs.
- ⛔ **Corpus is 12 cases, 7 of them scored.** Small. A percentage over 7 is a pilot result,
  not a platform characterisation.
- ⛔ **Single-instance only.** Every run is one app process against one database. Nothing here
  exercises concurrent reconcilers across instances, which is exactly the condition the
  advisory-lock bug lived in.
- ⛔ **Two critical in-catalogue misses are unfixed** (`rls-wide-open-policy`,
  `rls-write-path-over-permissive`). Fix them before the repair rate is quoted anywhere.
- ⛔ **No competitor lane exists.** Nothing here supports a comparative claim of any kind.

**Do not publish a number this suite has not produced.** And keep two sentences apart: *"we
built the first self-maintenance benchmark for a backend platform"* is a claim about a tool;
*"it repairs 4/4 injected faults with zero false positives"* is a claim about a result. The
second one needs the corpus to be bigger than six.

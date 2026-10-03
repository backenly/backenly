# Structural probe inventory — Phase 4 gate artifact

Status: **inventory complete, implementation not started.**

This document is a gate, not notes. Phase 4 does not write code until every
candidate below is classified, because the failure it exists to prevent is a
probe that runs, returns something, and cannot actually distinguish one
explanation from another. A reasoning trail built on those looks thorough and
concludes nothing.

The rule this whole document enforces:

> **A probe existing is not the same as a probe being evidence. A probe that
> cannot falsify a hypothesis does not ship.**

---

## 1. The hypotheses

`subsystem_repeat_failure` says repairs across one area have stopped holding. It
does not say why. These are the candidate explanations, stated so they could be
wrong — a hypothesis that cannot be false explains nothing.

| id | Claim |
|---|---|
| `duplicated_lifecycle_state` | The same piece of state is represented in more than one place, so writes disagree and each repair fixes one representation. |
| `missing_constraint_permits_invalid_state` | The schema permits states the application assumes cannot exist, so bad rows keep arriving and each repair cleans up after them. |
| `policy_fragmentation` | Access to these tables is decided by many overlapping RLS policies, so the effective rule is not what any single policy says. |
| `split_brain_writers` | More than one writer maintains the same data and they disagree. |
| `no_structural_cause` | The repairs are unrelated. The area is busy, not broken. |

`no_structural_cause` is a first-class hypothesis with a real prior, not a
fallback. Without it the investigator is forced to name a cause for every
finding, which is how a diagnostic engine becomes a fortune teller.

---

## 2. The inventory

### 2.1 Policy count and overlap — **ADMISSIBLE**

| | |
|---|---|
| **Observation** | Number of RLS policies per table, their commands, and whether more than one applies to the same command on the same table. |
| **Source** | `pg_policies`, already queried in `lib/ai/agents/security-agent.ts:62` and `lib/ai/behavioral-verifier.ts:816`. |
| **Coverage limits** | `security-agent.ts:67` carries the comment *"pg_policies may not be accessible — continue without RLS info"*. So absence of rows must be reported as **unknown**, never as "no policies". Materialised views and foreign tables have no policies and are not in scope. |
| **Cost** | One indexed catalog read per project. Negligible. |
| **Falsifies** | `policy_fragmentation` directly — one policy per command per table refutes it. Provides no information about the other three. |

### 2.2 Constraint coverage — **ADMISSIBLE**

| | |
|---|---|
| **Observation** | Which columns in the component carry NOT NULL, CHECK, UNIQUE and FK constraints, and which state-ish columns carry none. |
| **Source** | `information_schema.table_constraints` / `pg_constraint`, the same catalogs `detectFkColumnsMissingConstraints` and `schema-design.ts` already read. |
| **Coverage limits** | A constraint's *absence* is a fact; whether it *should* exist is a judgement. The probe reports the absence and never asserts intent. |
| **Cost** | One catalog read. Negligible. |
| **Falsifies** | `missing_constraint_permits_invalid_state` — full constraint coverage on the state columns refutes it. Weak evidence toward `duplicated_lifecycle_state` at best, so it must not be counted for it. |

### 2.3 Column co-variation — **CONDITIONALLY ADMISSIBLE**

| | |
|---|---|
| **Observation** | Whether two columns on one table move together across rows, which is the shape of one state machine recorded twice. |
| **Source** | Aggregate reads over workspace row data, the pattern `lib/autonomy/schema-design.ts` already uses. |
| **Coverage limits** | **Hard gate at `MIN_ROWS_FOR_DESIGN_CLAIM = 50`.** That constant exists because "every value is distinct" is unremarkable at 5 rows and strong at 50. Below it the probe returns **inconclusive**, never "no co-variation". Also reads customer data, so it reports shapes and counts, never values. |
| **Cost** | One aggregate scan per candidate column pair. Bounded by only running on components that already fired. |
| **Falsifies** | `duplicated_lifecycle_state` — two state columns that move independently refute it. This is the only probe that speaks to that hypothesis directly, which makes the row-count gate load-bearing: below threshold, that hypothesis simply cannot be decided. |

### 2.4 Statement evidence — **CONDITIONALLY ADMISSIBLE**

| | |
|---|---|
| **Observation** | Which statements actually touch the component's tables, and how often. |
| **Source** | `pg_stat_statements`, schema-scoped, already parsed in `lib/ai/infra-intelligence.ts:214`. |
| **Coverage limits** | Three, all real. The extension may be absent (`infra-intelligence.ts:448` checks `pg_extension` and degrades). The view **resets** on `pg_stat_statements_reset()` and on restart. It has a **bounded ring buffer**, so infrequent statements are evicted. Therefore "no statement references this column" is weak evidence and must never be reported as proof. |
| **Cost** | One read, already performed elsewhere in the loop. |
| **Falsifies** | `split_brain_writers` **partially** — several distinct write statement shapes against one table is consistent with it, but so is one application with several code paths. It cannot separate those, so it may raise a hypothesis's prior and may not confirm it alone. |

### 2.5 Which tables a function writes — **INADMISSIBLE**

| | |
|---|---|
| **Observation** | Whether two `AiFunction`s both write the same table. |
| **Source** | Would require analysing `AiFunction.generatedCode`. |
| **Why inadmissible** | There is **no AST tooling in this repository** — no babel, acorn or ts-morph. `AiFunction.triggerTable` records what *fires* a function, not what it writes. The only remaining approach is string-scanning arbitrary JavaScript for table names, which produces confident wrong answers: a table named in a comment, a log line, or a variable counts the same as a write. |
| **Consequence** | `split_brain_writers` cannot be confirmed by this route. It survives or falls on §2.4 alone, which is weak — so the hypothesis may be *raised* and cannot currently be *confirmed*. That is stated in the verdict rather than hidden. |

This candidate is recorded rather than dropped because it was in the first draft
of the roadmap and will occur to the next person too.

### 2.6 Naming similarity — **CONTEXT ONLY, NEVER EVIDENCE**

| | |
|---|---|
| **Observation** | Columns with similar names (`status`, `account_status`, `user_status`). |
| **Why not evidence** | `lib/core/fix-classifier.ts:63` refuses to act "on the strength of a naming convention", and the finding policy forbids claims with no runtime evidence behind them. Similar names are equally consistent with a duplicated lifecycle and with two genuinely different concepts. |
| **Permitted use** | Selecting which column pairs §2.3 measures. It may direct attention; it may never support a conclusion. |

### 2.7 Table count / schema size — **INADMISSIBLE AS CAUSE EVIDENCE**

Describes complexity, falsifies nothing. Every hypothesis predicts the same
value, so it carries no information by the discrimination rule the hypothesis
engine already enforces.

---

## 3. Discrimination matrix

A probe earns its place by predicting *different* outcomes under different
hypotheses. Where a row is uniformly blank, that probe is decoration.

| Probe | `duplicated_lifecycle` | `missing_constraint` | `policy_fragmentation` | `split_brain_writers` |
|---|---|---|---|---|
| 2.1 policy overlap | — | — | **decides** | — |
| 2.2 constraint coverage | weak | **decides** | — | — |
| 2.3 co-variation | **decides** (≥50 rows) | — | — | weak |
| 2.4 statements | — | — | — | raises only |

Two hypotheses are decidable, one is decidable given data volume, and one is
not currently confirmable. That is the honest state.

---

## 4. Verdicts Phase 4 may return

```
structural_cause_identified   one hypothesis survived, a probe that DECIDES it ran
no_structural_cause           the evidence actively refutes the alternatives
inconclusive                  probes ran; nothing separated the survivors
```

`inconclusive` is a success state. It is what keeps this from being an
LLM-shaped fortune teller, and the existing hypothesis engine already records
inconclusive investigations deliberately — a record of what was ruled out is what
stops the next investigation repeating the dead end.

---

## 5. Confidence and coverage are reported separately

**This is the requirement Phase 5 depends on.**

A verdict carries two independent facts:

- **Hypothesis support** — which explanation survived, and which probe decided it.
- **Evidence coverage** — how much of the evidence the probes could actually see:
  whether `pg_stat_statements` was present, whether row counts cleared the
  co-variation threshold, whether `pg_policies` was readable.

These must never be collapsed into one number. "Policy duplication likely" and
"telemetry coverage 32%" are different facts, and multiplying them into a single
confidence score destroys the second one.

Phase 5 must refuse to build an executable maintenance plan from a hypothesis
whose deciding probe did not run. A hypothesis object existing is not permission
to act on it.

---

## 6. Exit criterion

> At least one structural hypothesis can be supported **or** falsified by
> deterministic evidence, with its coverage limits stated explicitly.

**Met.** §2.1 decides `policy_fragmentation` and §2.2 decides
`missing_constraint_permits_invalid_state`, both from direct catalog facts with
no sampling assumptions. §2.3 decides `duplicated_lifecycle_state` above 50 rows.

So Phase 4 ships, but **narrower than the roadmap imagined**:

- three hypotheses are decidable, one of them only above a data threshold;
- `split_brain_writers` can be raised and not confirmed, and says so;
- no probe depends on reading customer function source.

Phase 4 does not manufacture certainty to unlock Phase 5. If a run cannot
separate the survivors it returns `inconclusive`, and Phase 5 treats that as
"no plan", not as "a weak plan".

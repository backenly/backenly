# RFC: Intent, Evidence and Delegated Authority

**Status:** draft, for review. No implementation.
**Written against:** `f58ba317` (`#84` merged), after the eight-PR truthfulness audit.
**Scope:** the autonomous control plane — self-healing, self-maintenance, and
the authority model above both.

---

## 0. Executive summary

The audit that preceded this RFC fixed eight places where a surface asserted
something the runtime could not support. A probe reported an empty table it
could not read. A verifier that threw was recorded as success. A rollback spec
was treated as proof a rollback could run. Adoption deleted metadata for tables
it merely could not see.

Every one had the same shape: **an inability to know, converted into a positive
claim.** They are fixed. What they were hiding is now visible, and what is
visible is that Backenly's autonomy is a set of good primitives that do not
talk to each other.

The proposal is not new subsystems. It is a **join**, and one new abstraction —
the **Authority Decision** — through which every autonomous mutation must pass.
Five existing gates stop deciding independently and become inputs to one
decision that is recorded whether the answer is yes or no.

Two things genuinely must be built: a **principal model** (who acted) and a
**unified adaptation identity** (what happened, across both loops). Everything
else in this RFC is adaptation of something already in the tree.

**The honest version of the differentiation claim**, after checking competitors
rather than assuming (§21):

- Convex already has declared, versioned, provenance-carrying schema intent in
  `schema.ts`, enforced at write time. For **document shape**, Convex's model is
  stronger than Backenly's `SchemaIntent`, not weaker. Claiming intent as a moat
  in general would be false.
- Convex's `convex-self-heal` already runs capture → diagnose → repair →
  certify → human PR → promote, with standing consent per fix class. Claiming
  the loop, or per-class delegation, as unique would also be false.
- InsForge already scans every project **daily**. Scheduled *detection* is
  commoditized; no claim here may rest on it.
- What remains defensible is narrower and real: **intent that is not a property
  of application code** — ownership/authorization semantics, performance
  objectives, and explicit "do not touch" boundaries — continuously *reconciled*
  (not merely detected) against a live database **with nobody in the session**,
  under authority that contracts when the observers degrade.

That narrowing is the most important result in this document, and it points
directly at the recommended first vertical slice (§19): **ownership intent**.

---

## 1. Current-state architecture

Phase A inspected each primitive against merged main. This table is the
corrected version; §1.1 lists where it differs from the Phase A handoff.

| Primitive | File | State | Missing |
|---|---|---|---|
| Intent | `prisma/schema.prisma:406` (`SchemaIntent`), `lib/autonomy/intent-conformance.ts:71` | column shape only, one writer | provenance, versions, non-schema scopes |
| Sensor confidence | `lib/autonomy/sensor-health.ts:204` | five-state, well designed | **never consulted before acting** |
| Execution mode | `lib/autonomy/execution-mode.ts:77` | authoritative, three distinct reasons | read by the dashboard only |
| Rollback capability | `lib/autonomy/maintenance/rollback-capability.ts:137` | default-deny registry with revisions | scoped to maintenance |
| Causal attribution | `lib/autonomy/change-correlation.ts:93` | four sources, refuses to claim cause | no principal on any source |
| Authority | five mechanisms, §1.3 | each works | they do not compose |
| Actor identity | four vocabularies, §1.2 | partially exists | autonomy writes none of them |
| Adaptation identity | three models, §1.4 | each works | they do not reference each other |

### 1.1 Four corrections to Phase A

These were checked against merged main and the Phase A handoff was wrong or
imprecise on each. They matter because three of them make the work *smaller*.

**(a) A principal precedent exists.** Phase A recorded that Backenly-as-actor is
"recorded nowhere" and concluded a principal model "must be introduced, not
adapted." That is wrong. `BackendEvent` (`prisma/schema.prisma:432`) carries
`actorType` and `actorId`, typed in `lib/operational-memory/ledger.ts:22` as:

```ts
export type BackendActorType = 'user' | 'backenly_agent' | 'system'
```

The correct finding is worse in one way and better in another: there are **four**
actor vocabularies, not three — and the fourth is a usable precedent that
already distinguishes platform action from user action. The real gap is that
**`lib/autonomy/` does not import the ledger at all.** The AI executor, the brain
and orchestration write `BackendEvent`; neither autonomous loop does. So the
model exists and the loops that most need it do not use it.

**(b) `SchemaIntent` has exactly one writer, and its type advertises a second.**
`source` is typed `'create_table' | 'add_column'`
(`lib/autonomy/intent-conformance.ts:75`), but the only call site is
`lib/ai/minimal-executor.ts:3966`, passing `'create_table'`. The brain's
`add_column` tool (`lib/ai/brain/tools.ts:331`) records no intent at all.

A column added after its table therefore has **no intent record**, and the
declared union says otherwise. This is the audit's own pattern surviving inside
the intent model: a type asserting a capability with no implementation behind it.

**(c) Sensor health has two callers, and neither is a decision.** Phase A said
"daily cron/reporting and one MCP tool." Precisely:

- `app/api/mcp/tool/route.ts:291` — the `check_sensor_health` MCP tool.
- `instrumentation.ts:132` — a daily `cron.schedule('40 0 * * *', …)`.

The cron's **entire effect** is `console.warn` when `!report.fullyInstrumented`,
plus the first-firing records that promote a probe from `unverified` to `clean`.
Nothing reads the report before acting. The comment above it states the problem
this RFC is solving, already, in the tree:

> `detectMissingRls` did that in every environment for months while the
> dashboard rendered green, because "no findings" and "cannot detect findings"
> are the same value.

**(d) The evaluation lab partly exists.** Phase A treated the lab as unbuilt.
`tests/lab/scenarios.ts` and `tests/lab/seed.ts` define **six** real-PostgreSQL
scenarios (`auth-heavy`, `ecommerce`, `messy-legacy`, `view-heavy`,
`multi-tenant-saas`, `content-community`) with real DDL, foreign keys, RLS
policies, views and seeded rows; `tests/probes/lab-scenario-bank.spec.ts`
exercises them. Its stated purpose is close to what §18 needs:

> Given a backend in a known state, does the machinery reach the correct
> conclusion — and, just as importantly, stay silent when it should?

But it validates **subsystem clustering**, not autonomy outcomes: the assertions
are about `expectedSkeletonComponents`, breadth guards and fingerprints. §18
extends this substrate rather than designing a lab from nothing.

### 1.2 Four actor vocabularies

```
human        AuditLog.userId / userEmail
agent        AgentApprovalRequest.apiKeyId          (destructive approvals only)
mixed        BackendEvent.actorType                 ('user'|'backenly_agent'|'system')
approver     MaintenanceApproval.approvedBy         (opaque String)
autonomy     — writes none of the above
```

`MaintenanceExecution` has no actor field at all. So "who ran this maintenance"
is answerable only through the approval, and only if one exists.

### 1.3 Five authority mechanisms

| Mechanism | Where | Vocabulary |
|---|---|---|
| Project dial | `lib/autonomy/autonomy-level.ts:23` | `OFF \| CONSERVATIVE \| BALANCED \| AGGRESSIVE` |
| Maintenance tiers | `lib/autonomy/maintenance/step.ts` | tier `0..3` |
| Plan entitlement | `autonomyMaxLevel` per plan | dial levels |
| Deployment flags | `lib/autonomy/execution-mode.ts` | `ENABLE_AUTONOMY_RECONCILER`, `ENABLE_AUTONOMY_LIVE_EXECUTION` |
| Agent approvals | `AgentApprovalRequest` | per-request consent |

They already interact in ad-hoc ways. The dial's tier ceiling is 1 even at
`AGGRESSIVE` — "Tier-2+ is never auto, ever"
(`lib/autonomy/autonomy-level.ts:100`) — while `MaintenanceApproval.maxTier`
separately caps consent at `MAX_APPROVABLE_TIER`, and tier 3 (`contract`) is
never approvable by a robot. Two different files encode overlapping ceilings in
different units. That is the fragmentation, concretely: not a missing gate, but
no single place that can state the effective one.

### 1.4 Three "something happened" models

```
HealthFinding             self-healing    (no actor, no execution link)
MaintenanceExecution      self-maintenance (+ MaintenanceStepExecution)
Incident                  conventional ops (title, severity, acknowledgedBy)
```

`Incident` references neither loop. This is the unification gap: not one model
missing a field, but three that do not know about each other.

---

## 2. Goals and non-goals

### Goals

1. One decision point that every autonomous mutation passes through, recorded
   whether it permits or refuses.
2. Authority that **contracts automatically** when the observations required to
   justify or verify an action are not trustworthy.
3. Intent that carries **provenance**, so the system can distinguish what a user
   declared from what Backenly guessed.
4. One causal story per adaptation, readable by a human and by an MCP agent.
5. Failure semantics that keep `unknown` distinct from `failed`, `denied` and
   `unsupported`, everywhere.
6. Incremental adoption: no flag-day rewrite, no primitive deleted before its
   replacement is measured.

### Non-goals

1. **This is not "the AI decides."** The decision layer is deterministic policy
   evaluation over recorded evidence. An LLM may propose an action or explain
   one; it never adjudicates authority.
2. **Not more detectors.** Detector count is not the metric and adding
   detectors is not differentiation.
3. Not a rewrite of execution, verification or recovery. That work is done and
   plugs in (§13).
4. Not a UI redesign. §20 states only what the data model must support.
5. Not prevalence research. With ~40 synthetic accounts there is no population
   to measure against; the lab measures correctness, not frequency.

---

## 3. Design principles

These are the audit's invariants, generalised. Each is already enforced
somewhere in the tree; the RFC's job is to make them structural.

| # | Principle | Origin |
|---|---|---|
| P1 | Inability to observe is never evidence of absence | `#77`, `#83` |
| P2 | Inability to verify is neither success nor proven failure | `#79` |
| P3 | Capability is what the deployment can execute, not what a type declares | `#80` |
| P4 | Consent binds to the exact forward and recovery contract reviewed | `#80` |
| P5 | Current capability comes from current configuration, not past evidence | `#82` |
| P6 | An advertised guarantee is an active check or a named structural guarantee | `#84` |
| P7 | Recovery authority binds to the execution, not to the plan | `#81` |
| P8 | Unknown capability is unsupported (default-deny) | `rollback-capability.ts` |
| P9 | Inferred intent never independently authorizes mutation | new, §5.3 |
| P10 | Required observation capability is a precondition of authority | new, §7 |
| P11 | An executor never certifies its own success | `#79` |
| P12 | Correlation is reported as correlation, never as cause | `change-correlation.ts:194` |
| P13 | A decision authorizes only while its inputs hold; prove they are unchanged at the mutation boundary, not merely re-read | new, §10.4 |
| P14 | Confidence decays: demonstrated capability is not current health | new, §7.2 |
| P15 | A refusal explains its blocker; silence is not a safe refusal | new, §10.1 |

P9, P10 and P13 to P15 are the ones this RFC adds. P9 and P10 prevent the
architecture from recreating the failure the audit spent itself removing:
Backenly guessing, then treating the guess as grounds to act.

P13 to P15 came out of review and each closes a gap the first draft opened.
P13 closes a time-of-check-to-time-of-use window the decision layer would
otherwise have introduced. P14 stops `clean` from meaning "worked once, months
ago". P15 stops a refusal from being indistinguishable from health, which is the
original sin of this codebase restated at the decision layer.

---

## 4. The principal model

### 4.1 Semantics before storage

Three roles must be separable on every adaptation, because they are routinely
different principals:

```
requestedBy   who asked for this            (agent, user, or a Backenly loop)
authorizedBy  whose delegation permits it   (always a human, transitively)
executedBy    who performed the mutation    (almost always a Backenly loop)
```

The distinction is load-bearing. "Claude Code requested a Tier-2 migration, the
owner's standing grant authorized it, the maintenance loop executed it" is three
principals and one sentence, and today it is unrepresentable.

`authorizedBy` is modelled here as a single principal, which holds while a human
grants authority directly. It likely needs to widen into an authorization chain
with a named root once organization policy is the source of authority — carried
as Q9 (§23.1), not designed here.

### 4.2 The type

```ts
type Principal =
  | { kind: 'user';      userId: string }
  | { kind: 'agent';     apiKeyId: string; onBehalfOf: string }
  | { kind: 'backenly';  loop: 'reconciler' | 'maintenance' }
  | { kind: 'operator';  via: 'deployment_flag' | 'cli' }
  | { kind: 'external';  role: string }          // direct psql; identity is a DB role
```

`external` deliberately cannot name a person. A direct `psql` connection is
identified by its PostgreSQL role and nothing more, which is exactly what
`change-correlation.ts:157` already reports. Pretending otherwise would be a P1
violation about actors instead of about tables.

This is **weak attribution by construction, not a gap to close later**: a shared
role identifies a credential and a context, and several humans and jobs may sit
behind one. §23.1 states the rules that follow from that, and they are binding on
any surface built on this model.

### 4.3 Adoption path

`BackendActorType` (§1.1a) is the precedent, and its three values map onto
`user` / `backenly` / `operator` without loss. The adapter direction is:

1. `Principal` becomes the canonical type in `lib/principal/`.
2. `BackendActorType` is derived from it, so existing ledger rows stay valid.
3. `lib/autonomy/` starts writing principals — the gap that matters most.
4. `MaintenanceApproval.approvedBy` and `AgentApprovalRequest.apiKeyId` are
   read through a resolver that returns a `Principal`, without a migration.

`AgentApprovalRequest` is the right template for a grant and should be read
closely before designing one: it already carries principal (`apiKeyId`), action
(`tool`), resource (`target`), blast radius (`rowCount`), reversibility
(`reversible`) and a time bound (`expiresAt`). It is scoped to one destructive
request; a grant generalises it across a class and a window. Its schema should
not be reused directly — it has no notion of a class of future actions — but its
*semantics* are close to correct.

**An agent may never grant itself authority.** It may read state, propose,
explain why approval is required, and poll an outcome. "My CI agent may approve
Tier-2 migrations in staging" is a grant a **human** creates naming the agent as
principal — categorically different from an agent calling an approval endpoint
for its own request.

---

## 5. Intent

### 5.1 What an intent is

**An intent is a durable assertion about what should be true of this
application, held independently of what is currently true.**

It is not a detector, not a policy, and not a fix. `orders.user_id references
users.id` is an intent. `create an index on orders.user_id` is not — that is an
action that might serve an intent about query latency.

### 5.2 Scopes

| Scope | Example assertion | Today |
|---|---|---|
| column | "`orders.created_at` is a non-null timestamp" | `SchemaIntent`, create-time only |
| relationship | "`orders.user_id` references `users.id`" | partial, via `requestedFkTo` |
| table | "`orders` is owned per-user" | **none** |
| API surface | "the public read contract of `/db/orders` does not break" | none |
| objective | "p95 read latency on `orders` stays under 100ms" | none |
| boundary | "**do not change** `legacy_billing`" | none |
| project | "no table may be readable across accounts" | platform invariant |

`table`-scoped **ownership** intent and `boundary` intent are the two with no
analogue at all, and §21 argues they are also the two a competitor cannot
express as a code-level validator. That is not a coincidence — it is the reason
§19 picks ownership for the first slice.

### 5.3 Provenance, and the rule that governs it

```
declared_by_user              the owner stated it
declared_by_authorized_agent  an agent acting under delegated authority stated it
platform_invariant            Backenly guarantees it structurally
observed_from_existing_state  learned from actions and history
inferred_by_backenly          Backenly's hypothesis about what is wanted
```

> **P9. Inferred or observed intent may explain, recommend, or request
> confirmation. It may never independently expand autonomous mutation
> authority.**

Promotion is explicit and one-directional:

```
inferred ──confirmation by an authorized principal──> declared
observed ──confirmation by an authorized principal──> declared
```

Nothing is promoted by confidence, by repetition, or by age. The failure being
designed out is precise: *Backenly guessed X, therefore treated X as true,
therefore changed production.* Confidence scores are recorded for ranking what
to ask about; they never cross into authority.

### 5.4 Versioning and conflict

Intents are **versioned assertions, never mutated in place.** A superseded
intent is retained, because "what did we believe when we acted" is the question
an incident review asks.

Precedence when two intents conflict, highest first:

```
1. boundary intents            "do not change X" beats anything that would
2. declared_by_user
3. declared_by_authorized_agent
4. platform_invariant
5. observed / inferred          never authoritative; recorded as context
```

Boundary intents outrank even the owner's other declarations, because they are
how a user says *stop*, and a stop that can be outvoted is not a stop.

Ranking `platform_invariant` below agent declaration is the one ordering that
should be challenged in review; it is listed as open question Q4 (§23). The case
for the current order is that a platform invariant a user's agent contradicts is
usually a tenancy guarantee that should refuse the agent's declaration instead —
which argues for *raising* it, not lowering it.

**Consent invalidation.** An approval is consent to a safety envelope, and
intent is part of that envelope. When an intent covering a resource changes
version, any pending approval touching that resource is invalidated. This is
exactly the argument already implemented for `planVersion`, which folds in the
forward and rollback capability contracts for the same reason
(`prisma/schema.prisma:3274`, `MaintenanceApproval`).

### 5.5 Violation versus unusual state

A violation requires **all three**:

1. an intent that asserts something,
2. evidence that the current state contradicts it,
3. a sensor whose status supports the claim (§7).

A state that is merely unusual — no intent asserts anything about it — is a
*candidate for inferred intent*, surfaced as an observation. It is never a
violation and never justifies mutation.

This is the line between "actual state violates declared intent" and "heuristic
X fired", and it is the main thing separating this from a lint catalogue. It is
also the line Supabase's advisor sits on the other side of (§21).

---

## 6. Evidence and observation

An **Observation** is a probe result with the metadata needed to judge it
later:

```ts
interface Observation {
  probeId: string
  observedAt: string
  freshnessSeconds: number
  sensorStatus: ProbeStatus        // lib/autonomy/sensor-health.ts
  result: 'violation' | 'conforming' | 'indeterminate'
  detail: Json
}
```

`indeterminate` is mandatory and is the direct descendant of `#77` and `#83`: a
probe that could not read the schema returns `indeterminate`, never
`conforming`. An `indeterminate` observation can never establish a violation and
can never establish success.

Evidence freshness is per action class (§8), not global. An RLS observation from
an hour ago is worthless if a migration landed since; an index-bloat observation
from an hour ago is fine.

---

## 7. Sensor confidence as a precondition of authority

> **P10. Sensor health is not a dashboard metric. It is a precondition of
> authority.**

`lib/autonomy/sensor-health.ts` already classifies every probe into five states,
with the crucial distinction already made:

| Status | Meaning | Effect on authority |
|---|---|---|
| `fired` | found something | observation is actionable |
| `clean` | ran, silent, **has fired before** — proven capable | supports `AUTO_EXECUTE`, **only while fresh and currently executing** (§7.2) |
| `unverified` | ran, silent, **never fired** — indistinguishable from broken | may observe; cannot support autonomous authority |
| `errored` | the probe failed | **`FREEZE`** whenever the probe is in the action's `requiredSensors` |
| `disabled` | not installed | **`FREEZE`** whenever the probe is in the action's `requiredSensors` |

The `clean` / `unverified` distinction is the best idea in the current codebase
and is currently consumed by a `console.warn` (§1.1c). Wiring it into the
decision is a small change to a proven component, not a new subsystem.

It is also not sufficient on its own: these five states describe a probe's
*demonstrated capability*, not its *current health*. §7.2 adds the two parts
that decay.

**`errored` and `disabled` are unconditional for a required sensor.** An earlier
draft read "`PROPOSE_ONLY` or `FREEZE`", which is too loose to sit beside §8's
rule that every required sensor must satisfy all four parts of §7.2. Left
ambiguous, an implementer could cite this table to emit an executable-looking
proposal built on evidence the architecture has already declared insufficient —
which is the failure in P15's clothing: an action that *looks* ready while its
grounds cannot be established.

`PROPOSE_ONLY` remains correct in exactly two cases, and both turn on the sensor
not being load-bearing for *this* action:

1. The failed probe is **not** in this action's `requiredSensors`. A broken
   latency sensor does not block an RLS proposal.
2. The failed probe **was** supplementary, and the action's required sensors
   independently establish the violation on their own. The proposal then rests
   entirely on trustworthy evidence, and the failure is context, not grounds.

Both cases are decidable from the action class's declaration, so this is a
lookup rather than a judgement call. If an action's required sensor is `errored`
or `disabled`, the answer is `FREEZE` — and per §10.1 that freeze must still say
which probe failed and how to restore it.

### 7.1 Degradation is per-dependency, never global

A global ladder is wrong. With the policy sensor errored and the index sensor
clean:

```
index maintenance      AUTO_EXECUTE   (its sensor is clean)
RLS repair             FREEZE         (its sensor is errored)
schema drift proposal  PROPOSE_ONLY
```

Disabling all autonomy because one observer is impaired is its own failure mode:
it removes repair capability precisely when something is already wrong.

### 7.2 Confidence decays: a sensor requirement is four parts, not one

The five-state model answers "has this probe ever proven it can fire". It does
not answer "is it working now". `clean` is computed from a first-firing that may
be months old, so a probe that fired in June and has been silently misconfigured
since July is still classified `clean` today. That is the same optimism the
audit removed everywhere else, surviving in the confidence model itself.

Confidence is therefore **not** a single status. A sensor requirement is
satisfied only when all four parts hold:

```
required probe        the specific probe this action depends on
current execution     its most recent run completed without error
confidence state      clean (never unverified, errored or disabled)
freshness bound       that run, and its evidence, are inside the action's window
```

`current execution` is the part that does not exist today, and it is cheap: the
daily cron in `instrumentation.ts:132` already runs every probe per project and
already throws its result away (§1.1c). Persisting last-run outcome and
timestamp turns a discarded log line into the liveness half of this requirement.

**Freshness bounds are per action class, never one global TTL.** The bound
belongs to the action because the underlying signal decays at completely
different rates:

| Signal | Reasonable bound | Why |
|---|---|---|
| Schema catalog shape | minutes to hours | changes only on DDL, and DDL is itself an observed event |
| RLS / policy configuration | minutes | security-relevant, and a migration can invalidate it instantly |
| Index existence | hours | slow-moving |
| Behavioural latency (p95) | short, and a window not a point | a single sample is noise; the bound is over an aggregation window |

A single TTL would have to be set to the shortest of these, making slow-moving
actions needlessly unrunnable, or to the longest, making security actions unsafe.

**A stale sensor is not a broken one.** Staleness resolves by re-observing,
which the system can do itself. The correct response is therefore to re-observe
and re-decide, not to `FREEZE` — freezing is for a probe that *cannot* produce a
trustworthy reading, not one that merely has not lately. This distinction is why
§10.4's table maps stale evidence to "re-observe" and bad sensor status to
`FREEZE`.

---

## 8. Action classes

An action class is the unit that declares its own dependencies. This is the
declaration that does not exist today, and it is what makes §7.1 mechanical
rather than a matter of judgement.

```ts
/** A sensor dependency, with the freshness bound that belongs to THIS action. */
interface SensorRequirement {
  probeId: string
  /** How old the probe's last successful run may be. Per §7.2, never global. */
  livenessBound: number               // seconds
  /** How old the observation it produced may be. Often shorter than liveness. */
  evidenceBound: number               // seconds
  /** Aggregation window, for signals where a single sample is noise. */
  window?: number                     // seconds
}

interface ActionClass {
  id: string                          // 'enable_rls' | 'create_index' | …
  tier: 0 | 1 | 2 | 3                 // reuses the maintenance tier scale
  requiredSensors: SensorRequirement[]
  verifier: SensorRequirement         // the probe that independently confirms
  recovery: RollbackStrategy | 'none'
  blastRadius: 'single_object' | 'table' | 'schema'
  reversibility: 'reversible' | 'irreversible'
}
```

`evidenceFreshness` was a single number on the action in an earlier draft. It is
now per sensor, because an action can depend on two probes whose signals decay at
different rates — `enable_rls` needs both a policy reading (minutes) and a
catalog reading (hours), and the stricter bound must not be forced onto both.

Three rules make the registry load-bearing:

- **Every required sensor must satisfy all four parts of §7.2.** A missing
  `livenessBound` is not a permissive default; an action class that fails to
  declare one is malformed and its actions are `FREEZE` until it does. Default-deny
  (P8) applies to the declaration itself, not only to capability lookups.

- **`verifier` may not be the executor.** P11, structurally.
- **`recovery` resolves through `ROLLBACK_CAPABILITY`**
  (`lib/autonomy/maintenance/rollback-capability.ts:137`), which is already
  default-deny with semantic revisions. An action whose recovery is
  `not_implemented` is never `AUTO_EXECUTE`; it may still be `PROPOSE_ONLY` if
  policy permits an irreversible change under explicit human consent.

The `INVARIANTS` catalogue (`lib/autonomy/desired-state.ts:158`) already names a
probe per invariant, so the sensor half of the mapping largely exists. What is
missing is the declaration at the action end.

---

## 9. Delegated authority

### 9.1 The grant

```
principal × action class × resource scope × environment
          × max tier × max blast radius × time window × budget
```

Today's dial answers roughly `action-risk → yes/no` and nothing else.

### 9.2 Effective authority is an intersection

The five existing mechanisms become **inputs**, not independent interpreters:

```
effective authority
  =  user delegation           (the dial, as a coarse preset over real policy)
  ∩  deployment capability     (resolveExecutionMode)
  ∩  plan entitlement          (autonomyMaxLevel)
  ∩  action risk policy        (tiers, action class)
  ∩  sensor confidence         (§7)
  ∩  verification capability   (is there a probe that can confirm success?)
  ∩  recovery capability       (ROLLBACK_CAPABILITY)
  ∩  conflict context          (§12 — is somebody else changing this now?)
```

An intersection, not a priority race. Nothing in that list is deleted; each
keeps its meaning and stops deciding alone.

### 9.3 Can a user delegate past a missing capability?

Partly, and the boundary matters.

- **Missing recovery, explicit consent:** permitted for `PROPOSE_ONLY` with a
  human confirming an irreversible action. This is a real thing users want.
- **Missing verification:** never. "The user accepted the risk" cannot make an
  unverifiable action verifiable. Consent changes what may be attempted, not
  what can be known. Allowing this would reintroduce `#79` through the policy
  layer.

---

## 10. The Authority Decision

Every proposed autonomous action produces one Authority Decision before
anything mutates. It is a record, not a boolean, and it is written whether the
answer is yes or no.

```
proposed action
      │
      ├── which intent is being protected, at what provenance?
      ├── what evidence establishes the violation?
      ├── how trustworthy are the sensors that produced it?
      ├── what authority has been delegated, to whom?
      ├── which resource, in which environment?
      ├── what is the blast radius?
      ├── is verification available for this action?
      ├── is recovery available for this action?
      └── has a human or agent touched this resource recently?
                          ↓
                 AUTHORITY DECISION
```

### 10.1 The outcome is four-valued

```
AUTO_EXECUTE    act now, within the stated bounds
PROPOSE_ONLY    prepare it, surface it, do not act
FREEZE          no mutation and no executable repair proposal; explain the blocker
DENY            this action is never permitted here
```

`FREEZE` and `DENY` are deliberately distinct. `FREEZE` is temporary and about
*capability* — something is impaired and may recover. `DENY` is permanent and
about *policy* — no sensor improving will change it. Collapsing them lets a
transient outage read as a policy decision, and a policy decision read as
something that might resolve itself.

`FREEZE` is also the answer that did not exist during the audit. Every bug `#77`
through `#83` was a case where the system had no way to say *"I cannot establish
this"* and therefore said something else.

**`FREEZE` silences the repair, not the system.** An earlier draft defined it as
"do not act and do not propose", which is too broad in its second half: a frozen
action that says nothing reproduces the failure it exists to prevent, because
the user sees a quiet surface and infers health. Precisely:

| Under `FREEZE` | Permitted? |
|---|---|
| Mutate the resource | **no** |
| Present an executable repair proposal for that resource | **no** |
| Report the blocker as a diagnostic, naming the failed prerequisite | **yes, required** |
| Propose or perform remediation **of the broken prerequisite itself** | **yes** |
| Count the action as healthy, clean, or verified | **no** — it is `unchecked` |

The distinction is that a frozen RLS action must not offer "apply this policy",
because the evidence for needing it cannot be established. It must say:

> RLS reconciliation is frozen because sensor `detect_missing_rls` is errored.
> Restore that probe before Backenly can establish whether a repair is needed.

The second line is the actionable part, and it points at the *prerequisite*, not
at the resource. Repairing a broken probe is itself an action class with its own
decision, and it is usually available when the action it blocks is not — which
is what makes `FREEZE` a state a user can exit rather than a dead end.

### 10.2 The receipt

```ts
interface AuthorityDecision {
  decision: 'AUTO_EXECUTE' | 'PROPOSE_ONLY' | 'FREEZE' | 'DENY'

  adaptationId: string         // §11
  actionClass: ActionClassRef
  resource: ResourceIdentity   // reuses maintenance/resource-state
  environment: 'development' | 'staging' | 'production'

  intent: {
    id: string
    version: number
    provenance: IntentProvenance
    assertion: string          // what should be true, in words
  } | null

  evidence: Observation[]      // §6, each carrying its sensor status

  authority: {
    requestedBy: Principal
    authorizedBy: Principal | null
    grantId: string | null
    /** The exact version decided under, for the §10.4 contract to compare. */
    grantVersion: number | null
    narrowedBy: string[]       // every input that reduced the answer
  }

  capability: {
    verification: 'available' | 'unavailable'
    recovery: RollbackStrategy | 'none'
    recoveryStatus: RollbackCapability      // 'implemented' | 'not_implemented'
    recoveryRevision: string                // binds consent to the contract
  }

  conflict: CorrelatedChange[] // §12

  reasons: string[]            // ordered, machine-readable, human-legible
  decidedAt: string
}
```

`narrowedBy` is the field that makes this reviewable. A decision that came back
`PROPOSE_ONLY` should say *which* of the eight intersection inputs produced that
answer, in order. Without it the record explains nothing and the UI in §20
cannot be built.

### 10.3 Where it sits

The decision is evaluated **after** planning and **before** execution, in both
loops:

```
reconciler:   observe → finding → plan fix   →[DECISION]→ execute → verify
maintenance:  observe → plan ladder → approve →[DECISION]→ step   → verify
```

Placing it after planning is deliberate: the plan is what names the resource,
and a decision about an unnamed resource is not a decision. The maintenance path
already re-checks consent and catalog fingerprint immediately before every
privileged rung (`lib/autonomy/maintenance/execute.ts:339`); the decision joins
that check rather than replacing it.

### 10.4 A decision is a lease, not a certificate

A stored `AUTO_EXECUTE` is not permission that keeps. Between deciding and
mutating, an intent can be superseded, a grant revoked, a sensor can break, the
resource can be replaced, and another principal can start changing the same
object. Without an explicit rule, this architecture would introduce its own
time-of-check-to-time-of-use gap:

```
decision valid → the world changes → stale AUTO_EXECUTE → mutation
```

That would be a new instance of exactly the failure class this whole audit
removed: acting on a belief that was true once and is no longer checked.

> **NORMATIVE.** An Authority Decision authorizes execution only while its
> decision inputs remain valid. Execution **must revalidate every mutable safety
> input immediately before mutation**, inside the same single-flight lock as the
> mutation itself.
>
> **The execution lock alone is not sufficient.** Each mutable authority input
> must *either* be serialized with execution through the same coordination
> mechanism, *or* be revalidated through a version, compare-and-set or lease
> contract that proves the value has not changed at the mutation boundary.
> Revalidation under the execution lock is insufficient whenever the input's
> **writer** does not share that lock.

The mutable inputs, and what a changed value means:

| Input | Revalidated against | On mismatch |
|---|---|---|
| Intent version | current `Intent.version` for the resource | decision void, re-decide |
| Grant validity | not expired, not revoked, budget remaining | decision void, `PROPOSE_ONLY` |
| Required sensor status | current `ProbeStatus` per §8 | decision void, `FREEZE` |
| Evidence freshness | within the action class's bound (§7.2) | decision void, re-observe |
| Resource identity | observed shape and fingerprint | decision void, `blocked_stale` |
| Capability revisions | forward and recovery revision strings | decision void, re-decide |
| Conflicting recent change | §12, within the action class's window | decision void, `PROPOSE_ONLY` |

#### Who writes the input decides what revalidation must prove

The single-flight lock (`#78`) serializes *executors* against each other. It
does **not** serialize an executor against an owner clicking "revoke" in
settings, because the settings API never acquires it. So for any input whose
writer sits outside the lock, a plain read under the lock proves nothing:

```
executor acquires the project lock
  → reads grant: valid
      → owner revokes the grant through the settings API   (never takes the lock)
  → executor mutates under a grant that no longer exists
```

The lock was held throughout and the race still happened. This is why the rule
above is two-branched, and the branch required depends on who the writer is:

| Input | Writer | Shares the execution lock? | Therefore |
|---|---|---|---|
| Grant validity | owner, via settings API | **no** | version/CAS, or make revocation take the lock |
| Intent version | user or agent, via API | **no** | version/CAS |
| Operator flags / config | deployment | **no** | re-read at the boundary; cannot be CAS'd, so treat as advisory and fail closed |
| Required sensor status | probe runs | **no** | re-read plus freshness (§7.2) |
| Resource identity | DDL, any source | **no** | observed fingerprint compare (already `#81`'s stale guard) |
| Capability revisions | the deployed build | n/a, immutable per process | compare captured revision strings |
| Conflicting recent change | many | **no** | re-query the window (§12) |

Note that **every row but one has a writer outside the lock.** That is the point:
"revalidate under the lock" would have been true and nearly useless.

**This RFC does not choose the mechanism.** Two implementations are plausible
and the trade-off is real: comparing `grantVersion == decision.grantVersion` as
part of atomically claiming execution is cheap and local but must be threaded
through every authority writer; routing policy mutations through the same
project-level advisory lock is simpler to reason about but puts a user-facing
settings write behind a lock held by long-running maintenance. Phase 2 should
pick one with the shadow data in hand.

#### Three properties keep this honest

- **A revalidation that cannot complete is not a pass.** If the revalidation
  read itself fails, the answer is `FREEZE`, never "proceed". P1 applies to the
  safety check as much as to the observation.
- **A void decision is recorded, not silently retried.** The superseded receipt
  and its reason are written, because "Backenly was about to act and stopped
  because the grant had been revoked" is exactly the event an owner should see.
- **Proving freshness is not proving unchanged.** A value re-read a millisecond
  before the mutation is still a read, not a lease. Only the version, CAS or
  lock contract establishes that it did not change *during* the mutation.

Static inputs — the action class, the environment, the resource *scope* — do not
need revalidation. Distinguishing them matters: revalidating everything on every
step would make long maintenance ladders unrunnable for no safety gain.

---

## 11. Unified adaptation identity

Self-healing and self-maintenance become one **Adaptation** with one lifecycle.
Maintenance stops being a separate universe and becomes an adaptation whose plan
happens to have several rungs.

```
OBSERVED
  → VIOLATION_ESTABLISHED          (intent + evidence + sensor support)
  → PLANNED
  → AUTHORITY_DECIDED              (the receipt, §10)
  → EXECUTING
  → VERIFIED | VERIFICATION_FAILED | VERIFICATION_UNKNOWN
  → (on positive failure only) ROLLBACK_*
  → CLOSED
```

Two transitions carry the audit's hardest-won rules:

- Only `VERIFICATION_FAILED` may enter rollback. `VERIFICATION_UNKNOWN` stops
  the tick and consumes breaker budget without triggering recovery (`#79`).
- `ROLLBACK_*` is four-valued — `verified`, `failed`, `unverified`,
  `blocked_stale` — and binds to the execution record, not the plan (`#81`).

### 11.1 How the three existing models relate

The recommendation is **not** to delete anything and **not** to force everything
into `Incident`:

| Model | Becomes |
|---|---|
| `HealthFinding` | the *deviation* an adaptation answers; gains `adaptationId` |
| `MaintenanceExecution` | the *plan execution* of an adaptation; gains `adaptationId` |
| `MaintenanceStepExecution` | unchanged; already the recovery authority (`#81`) |
| `AuditLog` | unchanged; the append-only record |
| `Incident` | stays conventional ops, gains an optional link to `Adaptation` |

`Adaptation` is a thin parent carrying identity, principals, lifecycle state and
the decision receipts. It is a new table because the alternative — extending
`Incident`, which has `title`, `severity`, `affectedServices`, `acknowledgedBy`
and a paging-shaped lifecycle — would mean an ops-incident record for every
index Backenly creates at 3am. That is the wrong noise model, and it is why
`Incident` should keep its job.

---

## 12. Causal attribution

`lib/autonomy/change-correlation.ts:93` reads four sources within a six-hour
window:

| Source | Read from | Carries a principal? |
|---|---|---|
| `autonomy` | `AuditLog` | project + action only |
| `external_ddl` | drift-watch captures | a **PostgreSQL role name** |
| `deploy` | `Deployment` | no |
| `schema` | `WorkspaceSchemaSnapshot` | no |

**A change made by Claude Code over MCP and a change made by a developer in the
dashboard both land in `schema`, and neither carries an actor.** That is the
concrete gap: the controller cannot distinguish "an agent is intentionally
migrating this resource right now" from "the schema moved." A controller that
cannot tell those apart will eventually fight the builder.

The fix follows from §4: once autonomy and the AI paths both write principals,
correlation carries `Principal` and the conflict input in §9.2 becomes real.

**The existing discipline must survive the change.** `summariseCorrelation`
refuses to assert cause, and says why:

> "Three things changed on this backend in the two hours before" is a fact.
> "This deploy caused it" would be a guess dressed as a finding, and the first
> time it was wrong the user would stop trusting every other number on the page.

This RFC proposes **temporal correlation with principal attribution**, not
causal inference. The word "caused" should not appear in any surface this
architecture produces.

---

## 13. Execution, verification and recovery

Unchanged, and that is the point. The audit left these in the right shape and
the decision layer sits above them:

- **Execution** stays typed actions through the governed executor. No SQL writes
  or DDL are exposed (`AGENTS.md`), and the recovery path uses narrow
  recovery-only primitives rather than widening destructive verbs (`#81`).
- **Verification** stays three-valued and positive-allowlist
  (`isVerifiedFix`, `#79`). `VERIFICATION_UNKNOWN` never reads as success.
- **Recovery** stays execution-bound with a stale-state guard and an independent
  verifier, and refuses when the observed resource no longer matches the
  recorded post-state (`#81`).
- **Single-flight** stays a per-project PostgreSQL advisory lock around
  `executeMaintenancePlan` on a pinned connection, failing closed
  (`lib/autonomy/maintenance/single-flight.ts`, `#78`).

The decision layer adds exactly one obligation to this machinery, and it is
§10.4: **the executor must revalidate every mutable decision input immediately
before mutating, inside the single-flight lock.** A recovery capability whose
revision changed between decision and execution voids the decision, exactly as
`planVersion` invalidates an approval.

This is a small change to the existing execution path rather than a new
mechanism, because the shape already exists. `lib/autonomy/maintenance/execute.ts:339`
already re-reads live consent and the catalog fingerprint immediately before
every privileged rung, and `#81`'s rollback already reloads the execution record
and re-observes the resource before acting. §10.4 generalises that discipline
from "consent and catalog" to the full input set, and extends it from
maintenance to the reconciler, which today has no equivalent re-check.

The honest way to describe the change: maintenance already does about half of
this, and the reconciler does none of it.

---

## 14. Failure semantics

One vocabulary, used everywhere. This table is the thing to grep for when
reviewing any future autonomy code.

| Term | Means | Never means |
|---|---|---|
| `indeterminate` | the observation could not be made | conforming, or violating |
| `unverified` | the check ran, was silent, has never fired | healthy |
| `unknown` | verification could not complete | success, or proven failure |
| `failed` | positively established: it did not work | unknown |
| `unsupported` | no implementation exists in this deployment | not needed |
| `blocked_stale` | the resource moved since it was recorded | failed |
| `FREEZE` | authority cannot be established right now; explain the blocker | denied, or silent |
| `DENY` | policy forbids it, permanently | freeze |

Six of these eight already exist in the tree. The contribution here is that they
are one vocabulary rather than six local ones, and that `FREEZE` exists at all.

---

## 15. Data model proposal

Conceptual. No migrations in this RFC.

```
Principal            (type, not necessarily a table — resolved from existing ids)

Intent
  id, projectId, scope, targetRef, assertion, provenance,
  version, supersedesId, declaredBy (Principal), declaredAt, retiredAt

AuthorityGrant
  id, projectId, principalRef, actionClassId, resourceScope, environment,
  maxTier, maxBlastRadius, expiresAt, budget, createdBy, revokedAt, revokedBy

Adaptation
  id, projectId, state, intentId, intentVersion,
  requestedBy, authorizedBy, executedBy,
  findingId?, maintenanceExecutionId?, incidentId?,
  openedAt, closedAt, outcome

AuthorityDecisionRecord
  id, adaptationId, decision, actionClassId, resourceIdentity, environment,
  evidence (Json), capability (Json), conflict (Json),
  narrowedBy (Json), reasons (Json), decidedAt
```

Notes on shape:

- `Intent` is append-only with `supersedesId`; `SchemaIntent` migrates into it as
  `scope: 'column'`, `provenance: 'declared_by_authorized_agent'` (§17).
- `ActionClass` is a **code registry**, not a table, for the same reason
  `ROLLBACK_CAPABILITY` is: a deployment's capabilities are a property of the
  deployed code, and a database row claiming otherwise would be P3 all over
  again.
- `AuthorityDecisionRecord` is written for refusals too. Refusals are the rows
  that answer "why did nothing happen", which is the second most common question
  after "why did you touch my database".

---

## 16. Adapters: what does not get rewritten

| Existing | Becomes | Rewritten? |
|---|---|---|
| Autonomy dial | a preset that expands to grants | no |
| `resolveExecutionMode` | the deployment-capability input | no |
| `autonomyMaxLevel` | the entitlement ceiling input | no |
| Maintenance tiers | `ActionClass.tier` | no |
| `MaintenanceApproval` | a scoped, single-plan grant | no |
| `AgentApprovalRequest` | a single-action grant | no |
| `ROLLBACK_CAPABILITY` | the recovery-capability input | no |
| `sensor-health` | the sensor-confidence input | no, but newly consumed |
| `change-correlation` | the conflict input | gains principals |
| Verification / rollback | unchanged | no |

The dial survives as a preset in the first phase. Whether it survives long term
is open question Q6 (§23); the argument for keeping it is that a four-position
dial is a real product affordance and grants are not something most users will
author by hand.

---

## 17. Migration and adoption plan

No flag-day. Five phases, each independently valuable and independently
revertable.

**Phase 0 — Baseline.** Extend the lab (§18) and measure the *current* system.
Nothing ships. Without this there is no way to show the redesign improved
anything, and the temptation to declare victory by construction is exactly what
this whole audit was about.

**Phase 1 — Principals.** Land `Principal`, derive `BackendActorType` from it,
and make `lib/autonomy/` write principals on every audit row. Immediately
useful on its own: "who did this" becomes answerable before any decision layer
exists.

**Phase 2 — Action classes and the decision, in shadow.** Register action
classes for the fix types the reconciler already applies. Evaluate the decision
for every proposed action and **record it without enforcing it**. Compare what
the decision *would* have refused against what the loop actually did. This is
the phase that either validates or kills the design, and it is cheap because
`ENABLE_AUTONOMY_LIVE_EXECUTION` already gives the system a shadow mode with an
honest surface (`#82`).

**Phase 3 — Enforce for one action class.** The vertical slice (§19). One class,
enforced end to end, measured against the Phase 0 baseline.

**Phase 4 — Intent generalisation.** `Intent` table, `SchemaIntent` migrated in,
`add_column` finally writing intent (§1.1b), ownership and boundary scopes.

**Phase 5 — Adaptation identity.** The parent record and the causal story.

Phases 1, 2 and 4 each fix a standing defect even if the rest is abandoned. That
is the test for whether a phase is correctly scoped.

---

## 18. The Autonomy Evaluation Lab

### 18.1 What exists

`tests/lab/scenarios.ts` + `seed.ts` + `tests/probes/lab-scenario-bank.spec.ts`:
six real-PostgreSQL scenarios with real DDL, foreign keys, RLS policies, views
and seeded rows, asserting subsystem-clustering topology. Real database, no
mocks, per `AGENTS.md`.

### 18.2 What must be added

The substrate is reusable; three things are missing.

**(a) Fault injection.** `LabScenario` describes a healthy backend. The lab needs
a `LabFault` applied after seeding:

```ts
interface LabFault {
  id: string
  apply: (schema: string, pg: Client) => Promise<void>
  /** What the system SHOULD conclude — declared per fault, not derived. */
  expected: {
    detected: boolean
    actionClass: string | null
    decision: 'AUTO_EXECUTE' | 'PROPOSE_ONLY' | 'FREEZE' | 'DENY'
  }
}
```

Declaring `expected` per fault, rather than computing it, follows the existing
bank's own reasoning about `expectedSkeletonComponents`: a lab that accepts
whatever the system produces is indistinguishable from one that works.

**(b) Independent oracles.** The oracle must not share code with the component
under test. For schema facts that means reading `pg_catalog` directly in the
test — the discipline that made `#79`'s regression meaningful (it asserted
`pg_index` showed exactly one new index, which proved both that the mutation
happened and that the next one stopped).

**(c) Sensor fault injection.** The class of fault the current bank cannot
express, and the one this architecture exists for: breaking the *observer* rather
than the backend. Revoke catalog permissions, run as a `NOSUPERUSER
NOBYPASSRLS` role, kill the connection mid-probe, make the verifier time out.
The correct answer to all of these is `FREEZE`, and no current test can ask the
question.

### 18.3 Scenario families

Grouped by what they test, not by symptom:

| Family | Examples |
|---|---|
| Deviation detection | missing RLS, missing FK, missing index, schema drift, policy fragmentation |
| Observer failure | catalog permission loss, RLS-blind read, connection failure, probe timeout |
| Verification failure | verifier throws, verifier times out, partial repair |
| Recovery | rollback success, rollback verifier blind, resource changed between mutation and rollback |
| Conflict | concurrent human migration, concurrent agent mutation, deploy in flight |
| Authority | sensor degraded, recovery unsupported, grant expired, tier exceeded, boundary intent present |

The `Observer failure` and `Authority` families are new and are where the
architecture's value is demonstrated or disproven.

### 18.4 Metrics

Per **action class**, not globally — a single aggregate would hide the case
where index repair is excellent and RLS repair is dangerous.

**These are two different kinds of number and must never be summed.** An
earlier draft weighted unsafe action and over-refusal equally. That is wrong: a
single aggregate that trades one unsafe autonomous mutation against one
unnecessary refusal creates precisely the wrong optimization incentive, because
the two failures are not commensurable. An unnecessary refusal costs utility and
is recoverable by a human. An unsafe mutation costs a user's data and may not be.

**Tier 1 — safety constraint. A release gate, not a score.**

```
unsafe-action rate           mutations that should not have happened
verification correctness     confirmed/failed/unknown vs ground truth
rollback correctness         including blocked_stale accuracy
```

> **NORMATIVE.** For any action class to become eligible for automatic
> authority (`AUTO_EXECUTE`) in production, it must show **zero observed unsafe
> actions** across the lab scenario bank. This is a gate, not a target to
> optimize toward, and it is not tradeable against any utility metric.

Zero-observed is a weak guarantee and is stated as such: it means "no unsafe
action was observed in the bank", not "unsafe action is impossible". It is the
strongest claim the lab can support with no user population
(`project_user_base_is_synthetic`). Statistical budgets — an unsafe-action rate
below some bound, with confidence intervals — become meaningful only once there
is real traffic, and should replace the zero-observed gate then, not before.

**Tier 2 — utility metrics. Optimize these, within the Tier 1 constraint.**

```
detection precision / recall
correct-refusal rate             FREEZE/DENY where that was right
over-refusal rate                FREEZE where action was safe and justified
authority-decision correctness   decision vs the fault's declared expectation
evidence completeness            % of actions with a full receipt
time to detection / time to repair
```

Over-refusal stays a first-class metric, and it is still the one most likely to
be ignored: every audit PR made the system refuse more, and `#80` left every
maintenance ladder `blocked_by_capability`, which is correct and is also a
product with no autonomy in it. The change is that over-refusal is now measured
and reported **separately**, as the cost of the safety constraint, rather than
netted against it.

Both tiers are reported per action class, never as one number.

### 18.5 Shadow and counterfactual

Once Phase 2 records decisions without enforcing them, the lab can replay real
project history and ask: what would the decision layer have done, and would it
have been right? That is the cheapest possible evaluation and it should be built
into the lab's shape from the start.

---

## 19. First vertical slice: ownership intent

**Recommendation: `table`-scoped ownership intent, end to end.**

The assertion: *"`orders` is owned per-user; a row is readable only by the user
in `orders.user_id`."*

Why this one:

1. **No reviewed competitor documents this class of assertion.** §21 shows
   Convex's `schema.ts` covers document shape at write time and Supabase's
   advisor lints for RLS being absent. Neither is documented as holding *"this
   table is user-owned"* as a durable, attributable assertion — one is a type,
   the other is a lint with no declarant. Whether this is a *structural* limit
   or merely an unbuilt feature is not established, and the slice does not
   depend on it being structural.
2. **It exercises every part of the architecture.** It has a declared intent, a
   probe with a known blindness history (`detectMissingRls`), a real repair, an
   independent verifier, a recovery strategy, and a genuine unsafe failure mode.
3. **The probe's failure is documented.** `detectMissingRls` returned `[]`
   while broken, for months, in every environment. The slice can therefore be
   evaluated against a fault the system has actually suffered.
4. **It is where `FREEZE` earns its existence.** An RLS observation taken by a
   blind reader must not produce a repair, and `#77` proved the old code would
   have.

The slice covers: intent declaration (user or agent, with provenance) → version
→ observation → sensor-confidence check → deviation → evidence → authority
decision → plan → execution → independent verification → recovery if needed →
adaptation record → human and MCP explanation.

**Kill criterion.** If, at the end of the slice, the resulting experience is not
materially stronger than *Supabase advisor + MCP + an agent that applies the
fix*, the architecture is not worth expanding and this RFC should be revised
rather than scaled out.

---

## 20. MCP and human surfaces

What the data model must support, not a UI design.

| | Agent | Human |
|---|---|---|
| Read intent, evidence, decisions, adaptations | yes | yes |
| Declare an intent | yes — lands as `declared_by_authorized_agent` under a grant, else `inferred` | yes |
| Propose an adaptation | yes | yes |
| Explain why approval is required | yes | yes |
| Approve its own proposal | **never** | n/a |
| Act under a grant a human created naming it | yes, within the grant | n/a |

The causal story the model must be able to render, for one adaptation:

```
03:14  deployment changed orders.user_id          (correlation, principal: operator)
03:15  ownership probe observed a policy gap      (sensor: clean)
03:16  declared ownership intent violated          (declared_by_user, v3)
03:16  decision: AUTO_EXECUTE                      (narrowedBy: [])
03:16  enable_rls + owner policy applied
03:16  independent re-observation confirmed        (verified)
```

Every line is a stored field, not a reconstruction. Today none of it is
addressable from one record.

One product note: autonomy MCP capability is currently reachable mostly through
a generic `read_backend_state`, and `check_sensor_health` is an unadvertised
tool. If sensor health becomes a precondition of authority, an agent needs to be
able to ask *why* an action was refused and get the receipt — otherwise the
agent's only experience of this architecture is unexplained refusal.

---

## 21. Competitive analysis

Researched September 2026 from vendor documentation and skill listings.
Confidence is marked per claim; "not found" is never reported as absence.

### 21.1 Supabase

| Claim | Confidence |
|---|---|
| MCP server exposes ~32 tools including `get_advisors`, `apply_migration` | verified, vendor docs |
| Security/Performance Advisor uses Splinter, an open-source Postgres linter (missing RLS, exposed `auth.users`, mutable search paths) | verified, vendor blog |
| Advisors are **read-only detectors**; nothing auto-applies recommendations | verified — vendor docs describe no autonomous apply |
| Safety model is **client-side, per-tool-call approval** plus `read_only=true` and `project_ref` scoping | verified, vendor docs |

Supabase's consent lives in the **MCP client, in the session**. "Most MCP
clients ask you to accept each tool call before it runs." That is a strong
control while a human is watching a session and provides nothing once the
session ends. **No server-side grant mechanism was found in reviewed primary
sources**, so no documented answer to "what may happen tonight" was identified.

### 21.2 Neon

| Claim | Confidence |
|---|---|
| MCP server manages projects, branches, schema, SQL, migrations | verified, vendor docs |
| `prepare_database_migration` runs the migration on a copy-on-write branch; the agent verifies; `complete_database_migration` merges | verified, vendor docs |
| `create_branch` supports `expiresAt` and `parentId` | verified, changelog 2026 |

**This is the strongest competing safety mechanism and it must be taken
seriously.** Copy-on-write branching gives cheap, general reversibility without
a per-operation recovery registry: if the migration is wrong, discard the
branch. Backenly's `ROLLBACK_CAPABILITY` exists because Backenly mutates the
live schema in place; a large part of `#80` and `#81` is work Neon's
architecture makes unnecessary.

Honest assessment: for *migration safety specifically*, branching is a better
primitive than execution-bound rollback. What it does not provide is continuous
reconciliation — a branch is created because an agent asked for one, and nothing
watches production when no agent is present.

### 21.3 Convex

The closest competitor to this RFC's thesis, and the one that most constrains
the claims.

| Claim | Confidence |
|---|---|
| `schema.ts` defines tables with validators; Convex enforces at runtime that documents match, and refuses to deploy a schema that does not match data at rest | verified, vendor docs |
| ~35 published agent skills including `convex-self-heal`, `convex-advisor`, `convex-sentinel`, `convex-verify`, `convex-authz` | verified, skill listings |
| `convex-self-heal` wires sentinel (capture) → findings bus (diagnose) → fixers (repair) → migrate-rehearse/tsc/probe (certify) → human PR (decide) → deploy-guard (promote) | verified, vendor skill description |
| Fixes are certified against real invariants on a **preview deployment** before review; "the human keeps the merge button" | verified, quoted |
| `deploy-guard` "gets standing consent for the loop's scope upfront (what classes of fix it may auto-prepare vs must always defer)" | verified, quoted |

Three claims this RFC cannot make, because Convex already has them:

1. **Declared, versioned, attributable intent.** `schema.ts` is intent with
   provenance (git history, code review) enforced *by construction at write
   time*. For document shape this is **stronger than detect-and-repair**:
   prevention beats reconciliation wherever prevention is possible. Backenly's
   `SchemaIntent` is weaker than `schema.ts` today, not stronger.
2. **A capture → diagnose → repair → certify loop.**
3. **Standing per-class consent.** `deploy-guard`'s "what classes of fix it may
   auto-prepare vs must always defer" is delegated authority by action class.

What differs, and it is narrower than the Phase A thesis assumed:

- **Trigger.** Convex's sentinel captures *production errors* — function
  failures, client crashes, OCC and scale signals. It is error-driven, so
  something must break first. A table that should be user-owned, has no policy,
  and has thrown no errors produces no finding. Intent-driven reconciliation
  detects deviation with no error and no traffic — which matters more for
  security intent than for performance intent.
- **Terminal authority.** Convex stops at a human PR. It never mutates
  production unattended, which is why it needs no execution-bound rollback, no
  stale-state guard and no `FREEZE`. That is a **simpler and arguably safer
  design**, and most of Backenly's extra machinery is the cost of choosing
  unattended execution.
- **Expressible intent.** `schema.ts` validators describe document shape. RLS
  policy shape, index existence, p95 latency and "never touch `legacy_billing`"
  are not document properties and are not expressible as validators.

### 21.4 InsForge

| Claim | Confidence |
|---|---|
| Agent-native BaaS: Postgres, auth, storage, functions, model gateway, operated by agents via CLI/MCP/skills rather than a dashboard | verified, vendor site |
| **Backend Advisor scans every active project daily** — security/performance/health findings with severity | verified 2026-07-14, vendor blog + docs |
| Each finding carries a **copyable remediation prompt** to paste into an agent; CLI surface (`insforge diagnose advisor`) | verified 2026-07-14 |
| **The platform never applies fixes itself** — remediation is by pasting into an agent | verified 2026-07-14, vendor blog |
| Branching/versioning, scoped permissions, reversible writes "with human approval" | verified 2026-07-14 |
| Positions on agent ergonomics — published benchmarks claim 1.6× faster, 30% fewer tokens | vendor marketing claim, not independently verified |
| Intent modelling, delegated authority, unattended execution | **not found** — no evidence either way |

Two corrections to the naive reading, both of which matter:

**"InsForge does nothing while you sleep" is false for detection.** The advisor
is scheduled and fleet-wide, not on-demand. Detection is commoditized across
Supabase, InsForge and Backenly alike, and no part of this RFC should be
justified by detection coverage.

**They have a real, if narrow, governance story.** Branching, scoped permissions
and reversible-writes-with-approval are not nothing. The gap is auto-apply, a
verify loop and per-project operational memory — and their homepage's autonomy
language describes *session-bound, agent-driven* build and deploy, not a
resident control loop. Third-party summaries claiming InsForge "applies fixes
autonomously without human intervention" are not supported by their own site.

Their remaining step to closing the gap is small: a scheduled agent consuming
their own remediation prompts. That makes this a months-long lead, not a
structural one, and it is the strongest argument for why §19's slice should
prove something a remediation prompt cannot express.

### 21.5 Summary

**Legend, and it is load-bearing.** This matrix distinguishes three different
epistemic states, because collapsing them would break the rule stated at the top
of §21:

- **yes** — documented capability, cited above.
- **documented limit** — the vendor *positively states* the boundary (for
  example Convex's "the human keeps the merge button"). This is evidence of
  absence.
- **none found** — not found in reviewed primary sources. This is **absence of
  evidence, not evidence of absence**, and must never be read as "they cannot
  do this" or repeated as a competitive claim.

| | Supabase | Neon | Convex | InsForge | Backenly (proposed) |
|---|---|---|---|---|---|
| Detects misconfiguration | yes (lint) | none found | yes (advisor) | **yes (daily)** | yes |
| Detects with nobody present | on demand | none found | sentinel, on error | **yes, scheduled** | yes, scheduled |
| Declared intent | none found | none found | **yes** (shape) | none found | yes (shape + ownership + objective + boundary) |
| Applies fixes without a human | none found | none found | **documented limit** (PR) | **documented limit** (paste-a-prompt) | yes, within a grant |
| Verifies the result | n/a | on a branch | on a preview | none found | in production, three-valued |
| Reversibility | migrations | **branching** | PR revert | branching, human-approved | execution-bound rollback |
| Consent model | per tool call, in session | per tool call | standing, per class | human approval per write | grant: principal × class × resource × env |
| Authority contracts when observers degrade | none found | none found | none found | none found | yes |

**Read the first two rows together before claiming differentiation.** Detection
is commoditized and scheduled detection is not unique.

The rows where Backenly's proposed position is not matched by anything found are
*applies fixes without a human*, *verifies in production*, and *authority
contracts when observers degrade* — and the last only has value because of the
first. Note the epistemic asymmetry: on *applies fixes without a human* two
vendors state the limit explicitly, so that row is well evidenced. On *authority
contracts when observers degrade* every cell is `none found`, which is the
weakest row in the table and should be re-checked before it is used in any
external claim.

---

## 22. Defensibility

> What can Backenly structurally know and prove about a production mutation that
> a competitor cannot reproduce by bolting an auto-fix button onto a BaaS?

For any change Backenly made, answerable from one record:

1. **What should have been true?** — the intent
2. **Who said so?** — provenance and principal
3. **What established it was not true?** — evidence, with the probe named
4. **Was the observer trustworthy?** — sensor status at decision time
5. **Who authorized this?** — the grant, and every input that narrowed it
6. **Why was this action inside that authority?** — the intersection, itemised
7. **How was success independently established?** — verification, three-valued
8. **Could it be reversed?** — recovery capability, and whether it still applies

An advisor answers (3). An advisor plus automation answers (3) and (7). Convex's
self-heal answers (1) for shape, (3), (7) on a preview, and part of (5).

**The plausibly hard-to-copy part is (4) and (6) together:** a controller whose
authority contracts when its own observers degrade, and which can itemise why.
That requires holding sensor confidence, action dependencies and delegated
authority in one evaluation, and it only *matters* if the system acts
unattended.

**No documented equivalent was found in reviewed primary sources**, which is not
the same as establishing that none exists — §21.5 marks that row `none found` in
every competitor cell, making it the weakest-evidenced row in the analysis. The
*explanation* offered here is a hypothesis, not a finding: vendors that stop at a
PR (a limit Convex and InsForge both state explicitly) never have to answer "was
the observer trustworthy at 3am", so the requirement may simply not arise for
them. Treat that as a reason to re-check the claim, not as proof of a gap.

### 22.1 Where this is not a moat

Stated plainly, because the handoff asked for the thesis to be attacked:

- **Detection is not a moat.** Splinter is open source. Any detector Backenly
  writes, Supabase can write.
- **MCP is not a moat.** Everyone has one.
- **The loop is not a moat.** Convex shipped it.
- **Per-class standing consent is not a moat.** Convex shipped that too.
- **Intent for schema shape is not a moat, and Convex is ahead.** A type system
  enforced at write time beats a reconciler for anything a type can express.
- **Rollback may be a self-inflicted cost.** Neon's branching makes much of
  `#80`/`#81` unnecessary at the architectural level. If Backenly could branch
  the workspace schema cheaply, some of the recovery registry would be dead
  weight. This deserves its own investigation and is open question Q7.

What is left, honestly: **unattended, intent-driven reconciliation of properties
that are not application code, under authority bounded by observability.** That
is a narrower claim than "autonomous backend platform" and it is defensible
because it is a composition, and the composition took eight PRs of truthfulness
work to make safe. A competitor adding an auto-fix button reaches the state
Backenly was in *before* the audit — which looked identical from outside and was
not the same system.

**The uncomfortable question for review:** is unattended execution what users
want, or is Convex right that the human should keep the merge button? If the
market prefers PR-gated fixes, most of this architecture is cost, not moat. The
lab (§18) cannot answer that; only users can, and per
`project_user_base_is_synthetic` there are none yet. That is the single largest
risk in this document and it is a product decision, not an engineering one.

---

## 23. Open questions

Marked where founder/product judgement is required rather than engineering.

| # | Question | Type |
|---|---|---|
| Q1 | Does `Incident` link to `Adaptation`, or stay fully separate? | engineering |
| Q2 | Is `boundary` intent enforced at the planner or the executor? Planner refuses earlier; executor is harder to bypass. | engineering |
| ~~Q3~~ | ~~Evidence freshness: per action class, or global?~~ **Resolved in review: per action class, and promoted into the core model as §7.2.** A global TTL is unsafe for security signals and needlessly restrictive for slow-moving ones. | resolved |
| Q4 | Should `platform_invariant` outrank `declared_by_authorized_agent`? §5.4 argues the current order may be backwards. | engineering |
| Q5 | How does a grant expire — time, budget, or explicit revocation only? | **product** |
| Q6 | Does the dial survive as a preset once grants exist? | **product** |
| Q7 | Could workspace schemas be branched cheaply, making part of the recovery registry unnecessary? | engineering, high value |
| Q8 | **Is unattended execution the product, or is PR-gated repair?** (§22.1) | **product, blocking** |
| Q9 | Does `authorizedBy` need an authorization **chain** rather than one direct human? See below. | engineering |
| Q10 | Which §10.4 coordination mechanism: version/CAS threaded through every authority writer, or routing policy mutations through the project advisory lock? Decide in Phase 2 with shadow data. | engineering |

Q8 is blocking before **Phase 3**, not before Phases 0–2. Measuring the current
system and building principal and decision observability are worth doing whether
or not the eventual answer is "users prefer PR-gated remediation".

### 23.1 Carried from review, not blocking

**Q9 — `authorizedBy` may need a chain, not an actor.** §4.1 models
`authorizedBy` as a single principal, which holds while a human grants authority
directly. It does not obviously hold once organization policy is the source: the
authority for an action may derive from a role, which derives from an org policy,
which was set by an admin who has since left. Recording only the leaf loses the
root, and "who is accountable for this grant" is an org-level audit question.

The likely shape is an authorization chain with a named root, resembling a
delegation path more than a field. Deliberately not designed here: it should
follow the organizations model rather than be guessed at now, and the single-
principal form is a strict subset that can widen without breaking.

**External role attribution is weak attribution, permanently.** §4.2 types
direct database access as `{ kind: 'external'; role: string }`. Worth stating
explicitly as a property rather than a limitation to fix later: **a shared
PostgreSQL role identifies a credential and a context, not a person.** Several
humans and several automated jobs may share one role, and the database cannot
distinguish them.

Consequences that follow, and should survive into implementation:

- Never render an `external` principal as a person, or with a person's name
  resolved from anywhere else.
- Never use `external` attribution as the basis for an authority decision about
  *who* acted. It is legitimate input for §12 conflict detection ("something
  outside the platform changed this recently"), which does not require identity.
- Surfaces should say "over a direct database connection as role `X`", which is
  what `change-correlation.ts:157` already does correctly today.

This is the actor-level form of P1: the system cannot observe who held the
credential, so it must not report a person.

---

## 24. Security and threat model

| Threat | Control |
|---|---|
| Agent self-authorization | An agent is never `authorizedBy`; grants are human-created and name the agent as principal (§4.3) |
| Compromised agent API key | Grant scoped by action class, resource, environment, tier, blast radius, time and budget; the blast radius of a stolen key is the grant, not the project |
| Poisoned inferred intent | P9 — inferred intent cannot authorize; promotion requires an authorized principal |
| Stale authority | §10.4: every mutable input is either serialized with execution or proven unchanged by version/CAS/lease at the mutation boundary; intent version change invalidates pending approvals (§5.4) |
| Revocation race | An owner revoking a grant mid-execution must win. The execution lock alone does not ensure this, because the settings API does not take it (§10.4) |
| Observer blindness used as evidence | P1 + `indeterminate` + sensor status as an authority precondition (§7) |
| Executor certifying itself | P11 — `ActionClass.verifier` may not be the executor (§8) |
| Conflicting principals | Conflict input (§9.2, §12); concurrent agent or human change narrows the decision |
| Cross-instance interleaving | Per-project advisory lock around execution, failing closed (§13) |
| Privilege escalation via grant authoring | Grant creation is a platform-auth action, subject to the same RBAC as other project settings; an agent cannot create a grant |
| Tenant boundary | Unchanged: Postgres grants enforce, not a SQL parser (`AGENTS.md`) |

Two residual risks worth naming:

- **The grant is only as good as its author.** A user who grants
  `AUTO_EXECUTE` broadly gets broad autonomous mutation. Presets (the dial)
  exist partly to make the dangerous grant harder to author by accident.
- **Advisory locks assume session semantics on the primary.** A transaction-
  pooling endpoint would invalidate the assumption while local tests still pass
  (§25).

---

## 25. What is proven, and where

Kept explicit, per the reporting rule this repository operates under.

**Proven locally, against real PostgreSQL:** RLS-blind probe behaviour under a
`NOSUPERUSER NOBYPASSRLS` role; verification fail-open regression via
`pg_index`; the three implemented rollback strategies including stale-state
refusal; advisory-lock mutual exclusion from a second connection; adoption's
metadata-loss reproduction.

**Not proven from this repository:** that the maintenance scheduler is
registered on the intended production instances; that the daily sensor-health
cron fires in production; that the advisory lock's connection reaches the
primary with session semantics rather than a transaction pooler; production
flag values. These require observation in the private deployment repositories
and none of this RFC's claims depend on them.

**Not measured at all:** every metric in §18.4, for the current system. That is
Phase 0 and it is the first thing to build.

---

## 26. Implementation sequence

```
RFC review                          ← here
  → Phase 0: lab baseline           measure the current system
  → Phase 1: principals             standalone value
  → Phase 2: decision in shadow     validates or kills the design
  → Phase 3: one vertical slice     ownership intent, enforced
  → measure against baseline
  → revise, then expand
```

Nothing in Phases 1–3 requires the full data model in §15. If Phase 2's shadow
comparison shows the decision layer would mostly have agreed with the existing
gates, the honest conclusion is that this architecture is not worth its cost,
and the RFC should be cut down to the parts that stand alone: principals,
`add_column` intent, and sensor health as a precondition.

---

## Appendix A: references

Architecture and research consulted, with what each contributed:

- **IBM autonomic computing / MAPE-K** — the Monitor-Analyze-Plan-Execute loop
  over shared Knowledge. Backenly's loops are MAPE-K; the contribution here is
  that K includes *confidence in M*, which the canonical model leaves implicit.
- **Kubernetes controller/reconciliation** — desired state held separately from
  observed state, level-triggered rather than edge-triggered. §5's intent model
  is the desired-state half; the divergence is that Kubernetes controllers own
  their resources outright and Backenly's authority is delegated and partial.
- **Runtime assurance / safety envelopes** — an action is permitted only inside
  a provable envelope, and the envelope contracts as assurance degrades. §7 and
  §9.2 are this idea applied to observability.
- **Google SRE, automated remediation** — the rule that automation must be able
  to determine whether its own action worked, and stop when it cannot. `#79` and
  §14.
- **Policy engines (OPA/Cedar)** — decisions as data, with reasons, evaluated
  deterministically over attributes. §10's receipt follows this rather than a
  boolean gate; the departure is that capability and sensor health are inputs,
  which conventional authorization engines do not model.
- **RFC 9315 (intent-based networking)** — intent as declarative outcome with
  explicit provenance and lifecycle. The terminology in §5.1 is deliberately
  aligned.

Competitor sources are cited inline in §21 and were read in September 2026.

## Appendix B: corrections to the Phase A handoff

For the record, since the handoff will be read again:

1. A principal precedent exists (`BackendEvent.actorType`); the model is
   adapted, not invented. Autonomy writing none of it is the real gap.
2. `SchemaIntent.source` advertises `add_column`; no caller produces it.
3. `checkSensorHealth` has two callers; the cron's only effect is a
   `console.warn`.
4. An evaluation lab substrate already exists with six real-PostgreSQL
   scenarios; §18 extends it rather than designing one.
5. The competitive thesis needed narrowing: Convex already has declared intent
   for shape, the self-healing loop, and standing per-class consent.

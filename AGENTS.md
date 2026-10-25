# AGENTS.md

Guidance for coding agents working in this repository. Read it fully before making changes.

This file follows the [AGENTS.md](https://agents.md) convention and is the single
source of truth; `CLAUDE.md` is a pointer to it. Keep it that way — this document
was previously duplicated, the two copies drifted, and a scrub applied to one of
them left the other still naming a production host.

---

## What is Backenly?

**Backenly** (live at https://backenly.com) is an **autonomous backend platform** that turns product descriptions into running backend infrastructure. It plans the backend, applies the infrastructure, verifies the runtime, and keeps every change reviewable and reversible. Developers describe their backend in natural language and Backenly automatically creates database tables, REST APIs, auth systems, storage, and more — no manual backend code required. (Category note: Backenly is **not** an "AI BaaS." It does not just generate resources — it manages backend change safely.)

**Tech Stack:** Next.js 14, React 18, Express.js, PostgreSQL (Prisma), MongoDB (optional), Claude on Amazon Bedrock or the Claude API (OpenAI also supported) through one AI gateway, Stripe payments (Cloud), TailwindCSS, TypeScript throughout.

**GitHub Repo:** https://github.com/backenly/backenly

---

## Critical Concepts (Read Before Touching Anything)

### 1. Two Completely Separate User Types

| Type | Who | Auth System | Where Data Lives |
|------|-----|-------------|-----------------|
| **Platform users** | Developers using backenly.com | `lib/auth/` + `JWT_SECRET` | `public` schema (Prisma models) |
| **End users** | Users of a project built *on* Backenly | `app/api/v1/[projectId]/auth/` + `project.jwtSecret` | `workspace_{projectId}.users` table |

**Never mix these up.** Platform auth touches `lib/auth/middleware.ts`. End-user auth uses project-scoped JWTs. They are completely isolated.

### 2. Multi-Tenant Schema Isolation

Each project gets its own PostgreSQL schema: `workspace_{projectId}`.

- All end-user tables, rows, and auth live inside that schema.
- The platform's own data lives in the `public` schema (managed by Prisma).
- Key files: `lib/tenant/isolation.ts`, `lib/services/workspaceDatabase.ts`

### 3. Every Production Change Is Governed

A change to a project's workspace runs inside `withGovernedChange`
(`lib/changes/ledger.ts`): checkpoint → apply → protected verification →
healthy, or automatic recovery when that is proven safe, otherwise a person
decides through the existing approval queue. Status moves only along the
edges in `lib/changes/lifecycle.ts`, which a database trigger also enforces, and
every step is an append-only `backend_change_events` row. Recovery plans,
impact measurement and the restore itself are `lib/changes/recovery.ts`; the
design is `docs/CHANGE_RECOVERY.md`.

- An executor action that runs DDL, or changes the rest of the backend (auth, storage, functions, webhooks, env vars, API keys, integrations), belongs in `GOVERNED_ACTIONS` in `lib/ai/minimal-executor.ts`; a service that changes one of those runs its write through `governedChange` (`lib/changes/ledger.ts`). One change, one history entry, one restore, whatever it touched (`lib/changes/resources/`). `scripts/assert-history-writes.ts` fails CI on a write to a recorded model that is neither governed nor explained by a `// history:` comment.
- Anything that destroys data in a schema change (drop a table or column, a lossy retype, a data rewrite) goes through `lib/changes/preserve.ts`, so the data moves into the change's vault instead.
- Verification is Backenly's (`lib/changes/verify.ts`), never the caller's: nothing an agent passes can skip or weaken it.
- A restore never silently removes or overwrites data written since the change. If it would, it waits for a person, who approves exactly the measured effect.
- Agents can request a restore, of one change (`deploy { action: "revert_change" }`) or of the backend to a published version (`deploy { action: "rollback" }`); only a person approves one, and what runs is the list Backenly measured when it was asked for.

### 4. Feature Placement Rule (Do Not Violate)

> Only the **Database Management** section creates new backend reality (tables, APIs). All other sections (monitoring, auth settings, billing) manage *existing* reality.

**Never** add "quick create" or "AI generate" buttons outside the Database section. Creation happens there or through an agent over MCP.

One deliberate exception, and only this one: an architecture change Backenly prepared and rehearsed (see "Architecture Evolution Engine") is approved from the Autonomy page's existing approval queue, like the maintenance ladder's rungs. Approving it is consent to a reviewed plan, not a creation button; it never offers to create anything of the person's choosing.

---

## Project Structure

```
/
├── app/                          # Next.js app directory
│   ├── api/                      # ~234 API route handlers
│   │   ├── ai/chat/route.ts      # Main AI chat entry point
│   │   ├── ai-workspace/         # AI plan/apply/diff/detect routes
│   │   ├── auth/                 # Platform auth (login, OAuth, JWT)
│   │   ├── billing/              # Stripe subscription (Cloud overlay) + AI usage
│   │   ├── database/             # Table & schema management
│   │   ├── database-brain/       # AI-powered DB analysis & fixes
│   │   ├── deployments/          # Deploy pipeline, logs, rollback
│   │   ├── monitoring/           # Metrics, anomalies, incidents
│   │   ├── storage/              # File storage
│   │   ├── cron/                 # Scheduled jobs (archive, cleanup, billing)
│   │   └── v1/[projectId]/       # PUBLIC runtime API for end-users
│   │       ├── auth/             # End-user sign-up/sign-in
│   │       ├── db/               # CRUD for workspace tables
│   │       ├── storage/          # File operations
│   │       ├── realtime/         # SSE + PostgreSQL LISTEN/NOTIFY
│   │       ├── broadcast/        # Ephemeral pub/sub
│   │       └── triggers/         # Event trigger management
│   └── app/                      # UI pages (Next.js app router)
│       ├── projects/[id]/        # Per-project dashboard
│       │   ├── (inspector)/      # Main IDE-like view
│       │   │   ├── database/     # DB management + AI chat
│       │   │   ├── api-builder/  # Visual API editor
│       │   │   ├── auth/         # Auth config
│       │   │   ├── storage/      # File storage UI
│       │   │   ├── users/        # End-user management
│       │   │   ├── monitoring/   # Metrics UI
│       │   │   ├── realtime/     # Realtime UI
│       │   │   ├── functions/    # Serverless AI functions
│       │   │   └── deploy/       # Deployment UI
│       │   ├── settings/         # Project settings
│       │   ├── history/          # Change history
│       │   └── iam/              # IAM config
│       ├── settings/             # Account settings
│       └── pricing/              # Pricing page
├── lib/                          # All shared business logic
│   ├── ai/                       # AI orchestration (THE CORE — see below)
│   ├── auth/                     # Platform auth & RBAC
│   ├── db/                       # DB clients (Prisma, MongoDB, hybrid)
│   ├── billing/                  # Credits, quotas, grace periods
│   ├── deployment/               # Deployment pipeline
│   ├── tenant/                   # Multi-tenancy isolation
│   ├── services/                 # Workspace DB, triggers, RLS, etc.
│   ├── middleware/               # Express middleware (20+ files)
│   ├── orchestration/            # 9-phase orchestration system
│   ├── config/                   # Engine modes, safety rails, references
│   ├── capabilities/             # Feature orchestrator (webhooks, exports, etc.)
│   ├── monitoring/               # Metrics, anomaly detection
│   ├── storage/                  # File storage abstraction
│   ├── execution/                # SQL execution, schema writes, rollback
│   ├── rollback/                 # Rollback management
│   ├── security/                 # Security utilities
│   ├── webhooks/                 # Webhook dispatch
│   ├── events/                   # Internal event system
│   └── errors/                   # Error codes, logger, sanitize
├── packages/sdk/                 # Client SDK (BackenlyClient)
│   └── src/                      # Published to public/backenly-sdk.js
├── prisma/                       # Prisma schema + migrations
│   ├── schema.prisma             # 68 models (see below)
│   └── seed-billing.ts           # Seeds billing plans
├── server/                       # Express runtime server (tsx server/index.ts)
├── scripts/                      # Evals, stress tests, automation
├── components/                   # Shared React UI components
├── docker/                       # Docker configuration
└── tests/                        # Jest test suite
```

---

## AI Orchestration — The Core of the Product

All AI logic lives in `lib/ai/`. The engine is the brain loop in
`lib/ai/brain/agent.ts`, reached over MCP via `app/api/mcp/route.ts`. There is
no in-product chat door; agents (Claude Code, Cursor, Codex) are the client.

Every model call goes through the AI gateway in `lib/ai/llm`: `generate`, or
`chat` for a caller that holds a message list. A call names its purpose, and the
purpose's route sets the model, thinking, effort, output ceiling and timeout
(`lib/ai/llm/config.ts`). Before a call is sent, its worst case is reserved
against the monthly spend limits (`lib/ai/llm/spend.ts`), and a customer-paid
call is also held against the account's AI credits
(`lib/entitlements/credit-holds.ts`). Product code reaches a model only through
the gateway; it never constructs a provider client of its own.

### Two-Brain Architecture

| Brain | File | Role |
|-------|------|------|
| Brain 1 | `lib/ai/brain/classifier.ts` | Classifies the turn once (BUILD / MODIFY / FIX / DESTRUCTIVE / QUESTION / CHAT) and routes it |
| Brain 2 | `lib/ai/minimal-executor.ts` | Converts intent graph into executable API calls (`CREATE_TABLE`, `GENERATE_API`, etc.) |

### Supporting Files

| File | Purpose |
|------|---------|
| `lib/ai/execution-engine.ts` | Orchestrates plan execution with MAX_STEPS + checkpointing |
| `lib/mcp/approvals.ts` | Queues a call that needs approval with its exact arguments; a person's approval runs that call verbatim |
| `lib/ai/brain/tools.ts` | Tool vocabulary; `DESTRUCTIVE_TOOLS` marks what needs confirming |

### 9-Phase Orchestration System

`lib/orchestration/index.ts` exports the production pipeline:
1. Intent canonicalization
2. State graph construction
3. Safety validation
4. Execution plan generation
5. Dry-run
6. Atomic executor
7. Silent migration
8. Trust timeline
9. Advanced view projection

### Available AI Actions (executor vocabulary)

Database: `CREATE_TABLE`, `ALTER_TABLE`, `DROP_TABLE`, `GENERATE_API`
Storage: `LIST_FILES`, `DELETE_FILE`, `GENERATE_SIGNED_URL`
IAM: `REVOKE_KEY`, `ROTATE_KEY`, `SET_KEY_PERMISSIONS`
Triggers: `CREATE_TRIGGER`, `LIST_TRIGGERS`, `DELETE_TRIGGER`
Permissions: `SET_PERMISSION`, `LIST_PERMISSIONS`, `REMOVE_PERMISSION`
Monitoring: `SET_ALERT`
Functions: `GENERATE_FUNCTION`

---

## Request Flow

```
Browser / SDK Client
  │
  ├─> app/api/ai/chat/route.ts        AI assistant — creates backend resources
  │     └─> lib/ai/ (intent + executor pipeline)
  │
  ├─> app/api/v1/[projectId]/...      Public runtime API (end-users)
  │     ├─> Auth: project jwtSecret
  │     └─> Data: workspace_{projectId} schema
  │
  └─> app/api/...                     Platform management APIs
        ├─> Auth: lib/auth/middleware.ts (platform JWT)
        └─> Data: public schema (Prisma)
```

### Platform API Middleware Chain

Every platform route chains through:
1. `authenticateRequest` from `lib/auth/middleware.ts` — validates platform JWT
2. `withProjectValidation` — verifies project exists and user owns it
3. Route-specific logic

---

## Database Layer

### Platform Data (Prisma-managed, `public` schema)

Key Prisma models (68 total):

| Model | Purpose |
|-------|---------|
| `User` | Platform users (sign-up, billing, roles) |
| `Project` | Developer projects |
| `Workspace` | Per-project workspace config |
| `BackendGraph` | AI-generated backend architecture |
| `ApiDefinition` | Generated REST endpoints per table |
| `ApiKey` | API key management |
| `Deployment` | Deploy records + logs |
| `ConversationMessage` | Chat history per project |
| `AiConfiguration` | Per-project AI model config |
| `AiFunction` | Serverless AI functions |
| `AppTrigger` | Event triggers (insert/update/delete/webhook) |
| `PermissionPolicy` | Row-level security policies |
| `Subscription` | Billing (Stripe ids on the row; `PaddleSubscription` is a retired, retained table) |
| `AuditLog` | Compliance audit trail |
| `SupportTicket` + `SupportMessage` | Support cases (Cloud): AI first response + team correspondence thread (`lib/support/`) |
| `StorageBucket` + `StorageFile` | File storage |
| `AgentMemory` | AI agent context/memory |
| `ProjectPreference` | Learned user preferences |

### Workspace Data (per-project, `workspace_{projectId}` schema)

Created dynamically. Contains:
- End-user `users` table
- All tables the developer creates via AI
- `_backenly_presence` — realtime presence tracking
- Notification channel: `workspace_{projectId}_changes`

### DB Files

| File | Purpose |
|------|---------|
| `lib/db/prisma.ts` | Prisma client singleton |
| `lib/db/postgres.ts` | Raw pg pool |
| `lib/db/mongodb.ts` | Optional MongoDB client |
| `lib/db/hybrid.ts` | Unified interface for both DBs |
| `prisma/schema.prisma` | Source of truth for platform schema |

---

## Client SDK (`packages/sdk/`)

A JavaScript SDK (`BackenlyClient`) for end-user apps. Built in `packages/sdk/src/`, published to `public/backenly-sdk.js`.

```js
// End-user app usage:
const backend = new BackenlyClient({ projectId, apiKey })
await backend.auth.signUp({ email, password })
await backend.posts.create({ title: "Hello" })
await backend.posts.list({ filter: { published: true } })
await backend.storage.upload(file)
```

SDK features: CRUD (list/create/get/update/delete), auth, storage, realtime subscriptions, presence, broadcast, QueryBuilder operators (`isNull`, `ilike`, `search`, `count`).

---

## Realtime System

Architecture: `Client → EventSource → PostgreSQL LISTEN → NOTIFY → SSE stream → Callback`

- Routes: `app/api/v1/[projectId]/realtime/`, `app/api/v1/[projectId]/broadcast/`
- SDK: `packages/sdk/src/realtime.ts`
- Features: DB change events, presence tracking, broadcast (ephemeral), auto-reconnect (3s backoff)
- Presence window: 60 seconds activity timeout
- Broadcast payload limit: 6KB

---

## Architecture Evolution Engine (`lib/evolution-engine/`)

Self-healing keeps a backend working; architecture evolution keeps it well-shaped. The engine is the loop — assess → classify → rehearse on a copy → ask a person → run under governance → verify → observe → judge → remember — and knows nothing about tables. A **primitive** (`lib/evolution-engine/primitive.ts`) is one kind of change; the first and only one today is **structural extraction** (`lib/structural-evolution/`), which moves a concern that has grown inside a table (`refund_*` on `orders`) into its own table through a behaviour-preserving ladder: rehearse on a rolled-back copy → create the satellite closed → forward sync → batched backfill → reconcile → expose reads → open writes (reverse sync, so old and new clients coexist) → reconcile → `contract` (dropping the old columns: planned, shown, **never run** by software). New primitives are registered in `lib/evolution-engine/installed.ts`; none of the governance below changes for them.

- **Levels, not a yes/no** (`levels.ts`): `no_change_recommended` (the common, first-class answer — active development, size and traffic are not debt), `watching`, `recommendation_only` (said, not run: no measured cost yet, or no safe ladder), `executable_proposal` (cohesive + separable + a MEASURED cost + a deterministic plan). Churn, size and traffic only rank; they can never raise a level.
- **Evidence rule (structural):** two cohesion families, one measured (co-presence, cohort, lifecycle or reference — names alone never qualify). A measured contradiction vetoes.
- **Structural, never semantic:** a primitive keeps today's meaning exactly (rows, cardinality, access). Cardinality, business meaning, transaction boundaries and API contracts are semantic redesigns: recommended at most, never executable (`policy.ts`). Every proposal states what it deliberately does not decide.
- **Lifecycle** (`lifecycle.ts`): proposed → rehearsing → rehearsed → awaiting_approval → approved → expanding → backfilling → verifying → cutover → observing → stable, plus blocked, failed, rolling_back, rolled_back. A transition the table does not allow is refused, never recorded. Cut over is not success: `stable` needs the observation window, enough passes, and measured agreement on the latest one.
- **Consent binds to SQL:** `planVersion` hashes the exact statements; the plan is rebuilt from the live catalog before every attempt and at approval, and approval reads the spec from the request row, never the request body. Consent, ledger and lock are the maintenance ladder's tables (`maintenance_approvals`, `maintenance_executions`, `maintenance_step_executions`, rows keyed `evolution:*`) and its advisory lock.
- **Backenly's own repairs wait for it** (`holds.ts`): while a change carries itself out (approved through cutover, and while rolling back), self-healing leaves its host and satellite alone. The auto-fix kernel asks once a repair is cleared to run and again inside the build lock, answering `held` to an autonomous actor: nothing runs, the finding stays open, and the reconciler counts `architecture_change`, a skip that clears itself; the agentic fix loop asks too. A repair that needs a person is still put in front of them. A change that waits on a person (`continuation` not unattended) holds nothing, nor does one that has not moved for three hours: no transition or job of its own, and, for changes still being applied (they run one at a time), none of theirs and no ladder holding the project's lock. No repair waits on a decision nobody may make, or on a change that stopped. A repair naming no table waits while any table is held if its action may act on every table (`EVERY_TABLE_ACTIONS`); the fix loop's always do. A repair that added a policy, an index or a trigger to the host would change the shape the person approved, and the change would stop.
- **Where a person decides:** an `architecture_evolution` HealthFinding in the Autonomy page's "Waiting on you" queue (`lib/evolution-engine/request.ts`) — never `open`, never with `details.fix`, never with `tableName`/`location`; every generic approve path refuses the type (`isEvolutionApprovalFinding`). Decisions go through `POST /api/projects/[id]/architecture` (approve, dismiss, pause, resume, undo), which needs a platform session and the maintenance-consent floor (organization ADMIN): agents read, never decide. Declining is `dismiss`, remembered and said in the activity feed; the health route's generic dismiss refuses the type, and its summary counts waiting requests apart (`architectureRequestsPending`), never as broken guarantees. Resume only continues what a person approved (a table that changed since is re-rehearsed and asked about again, unless part of the change is already built for the table as it was: then undo removes it, since a change waiting for approval cannot be undone); undo is claimed before it touches anything and either finishes, refuses with the change exactly as it was, or says what it already removed and offers only undo.
- **Dual representation is fail-closed** (`lib/structural-evolution/sql.ts` header has the case-by-case concurrency model): a committed transaction leaves host and satellite equal or does not commit; the host is the authority until `contract` — the satellite holds what the host STORED (after the host's own triggers, whichever table was written), and the host keeps enforcing its own constraints (foreign keys and NOT VALID constraints stay with it until `contract` re-creates them exactly); the backfill never waits on a writer (NOWAIT); crossing writers deadlock and PostgreSQL aborts one whole transaction. A partial view of the host (a restrictive policy hiding rows from Backenly's own context) stops the backfill and is never called consistent. `tests/integration/structural-evolution-concurrency.spec.ts` forces each interleaving; `structural-evolution-semantics.spec.ts` covers triggers, constraint semantics, hidden rows, TRUNCATE and forgery as a non-superuser owner.
- **Access never widens:** satellite rows are visible iff the parent row is (the parent's own policies decide), writes go back through the parent's UPDATE policy as the caller, and the rehearsal compares access identity by identity on the copy before anything is proposed — including the platform role itself, which the runtime serves end users as: the satellite's owner policy admits it only inside the ladder's own transaction-local context (`ladderAccessSql`), never while serving a client. The forward sync is the only SECURITY DEFINER function; every function the ladder installs is executable by its owner alone, resolves names in `pg_catalog` only (a READ_WRITE direct-access role may create objects in the workspace schema, and the functions run as the platform), and the forward sync refuses to run for any table but its host; a host whose primary key does not compare with a built-in operator is not planned. The reverse sync recognises the forward sync's own writes by the forward function's owner, never the table's: main's direct-access sync hands every table, the satellite included, to the project's `bkn_own_` role. The local test role is a superuser, which row-level security exempts, so security claims are tested as NOSUPERUSER NOBYPASSRLS roles (`structural-evolution-runtime-role.spec.ts`, `structural-evolution-semantics.spec.ts`, helper `tests/helpers/evolution-owned-workspace.ts`), and `structural-evolution-identities.spec.ts` runs the ladder over a login as the application role against every identity production has.
- **Where it runs:** every statement about a project's tables (catalog reads, samples, statistics, the rehearsal, every rung, the backfill, reconciliation, undo) goes to the project's own region's database through one handle (`lib/structural-evolution/workspace.ts`); platform records stay home. What a person asks of a regional project's change runs in its region too, as a regional job its own worker claims within a minute, since from home its statements outlast a request: the start of an approved or resumed change (`evolution_advance`), its undo (`evolution_undo`), a rehearsal again when its table moved since the person was asked (`evolution_rerequest`), and a look for changes (`evolution_assess`); `startWhereTheTablesAre` and its siblings in `engine.ts`. Home answers at once what it can tell (no such change, nothing to run or undo) and queues nothing; a start or an undo that finds another change running is tried again. A person's decisions on such a change are carried out one at a time, as when they run here: while one is in flight the next is refused with what is happening (pause, a stop, never is; a start still waiting carries a resume), and a re-check acts only on the change as it was when queued. Nothing is queued for a paused project; the person is told it is paused. Approval records consent under the build lock Backenly's own repairs take, tried without recording a build (`whileBuildLockFree`: no budget, no cooldown, no reaping), so a repair of the table has either finished before consent reads it or finds the change approved. The backfill batches are regional jobs too (`evolution_backfill`), each batch's starting key kept in the region; all of them are in `REGIONAL_JOB_TYPES` and wait while the project is paused. Each rung that changes the schema, and each undo, is a governed change (`lib/changes/ledger.ts`): under the project's change lock, between catalog checkpoints, verified by the control plane, on the change history as the person whose consent it ran under. None is recovered automatically, and the change history offers no restore of one step on its own (`ARCHITECTURE_CHANGE_GROUP` in `lib/changes/recovery.ts`): the engine's own undo, bound to a person and refused unless lossless, is the one way back. Restore to a point (`lib/changes/range.ts`) passes over a change whose undo finished, both after the point (the undo's group ends `:undo`), and otherwise stops before any of its steps. For a project kept outside the home region, its records at home (the request, the step ledger, memory, jobs) keep names, kinds, counts and ids, never a statement, a definition, a row's value or the database's words (`lib/structural-evolution/residency.ts`); the handle's `quote` decides, where the words are written. A person who opens the request's statements is shown them rendered live from the region (`GET /api/projects/[id]/architecture?statements=`); consent still binds to the version that hashes them. `structural-evolution-regional.spec.ts` runs an extraction in a second database standing in for another region.
- **Outcome is measured, never assumed** (`benefit.ts`): latency and error rates are guardrails that can only say "regressed" (a decisive rise in errors does, even on few requests); only a measurement of the cost that justified the change can say "beneficial", and never while another such cost got worse; otherwise `neutral` or `insufficient_evidence`, said plainly. "Beneficial" and "neutral" need the same check of existing clients: the API's guardrails, or, when nothing reaches the table over the API, the database's own (`population`); only then does a milestone say existing apps kept working. Counted benefits (changes that locked the host, problems found on the concern's columns, dismissed ones excluded, nothing while one is still open) are judged by an exact test between two equal windows, from history that must cover them. A measurement that fails keeps the change watched; a look 30 and 90 days on reconciles the data again, stops the change for a person on a regression, and takes "improved" back where the person reads it. Snapshots are kept in memory so before/after outlives log retention.
- **Architecture memory** (`memory.ts`): every transition, rehearsal, snapshot, observation and outcome is an `audit_logs` row of type `architecture` (`ARCHITECTURE_EVOLUTION` milestones are shown to people; `ARCHITECTURE_EVOLUTION_TRACE` rows are the engine's notebook and are excluded from activity feeds). The next analysis consults it: a change that was declined or undone is not proposed again until a cost is measured after that decision.
- **Flags:** `ENABLE_EVOLUTION_MUTATIONS` (off by default; assessment, observation and verification still run) and `ENABLE_EVOLUTION_SCHEDULER` (observation and daily proposal passes; resuming approved work also needs mutations and an autonomy level other than OFF, and waits out an incident like every autonomous change, `lib/autonomy/change-freeze.ts`). A person is asked to approve only where an approved change then finishes without them: both flags on and autonomy not OFF (`continuation` in `engine.ts`). Otherwise a ready change is said as a recommendation, a waiting request is withdrawn, and a change already approved shows "Waiting to start/continue" with the reason in plain words. While it rolls out, `EVOLUTION_PROJECT_ALLOWLIST` (project ids, comma-separated; unset means every project) narrows both flags to the projects it lists: an unlisted project keeps what already ran observed and undoable, but nothing is carried on or looked for there (`evolutionAllowedFor` in `lib/config/flags.ts`). Automatic undo on regression is a policy, off by default.
- **Surfaces:** approval in the Autonomy queue, outcomes in the activity feed and an "Architecture changes" card that appears only when there are any (a short headline, what was done, whether it helped in one clause, with the history and the numbers behind "View details"); what a person reads by default carries no count, step name, job id or database message (`lib/structural-evolution/words.ts`, `BenefitReport.plain`); `GET /api/projects/[id]/architecture` (concise; `?detail=1` for evidence and plans, `?decision=` for one change's history); read-only MCP `autonomy { action: "evolution" }`. Deterministic: no model calls.
- Not the same thing as `/api/projects/[id]/evolution` (the long-horizon orchestrator's model-written roadmap) or `lib/ai/architecture-evolution.ts` (life-stage heuristics).

---

## Billing (Stripe, Cloud only)

- Plans (internal code → display): SANDBOX → Free $0 · BUILDER → Pro $25/mo ($20 annual) · SCALE → Enterprise (custom, sales-led, no self-serve checkout) — seeded via the Cloud overlay's `prisma/seed-billing.ts`. Internal codes are stable; only display names/prices/quotas change.
- Payments are Stripe, in the Cloud overlay (`lib/billing/`, `app/api/billing/`): Checkout Sessions, the customer portal, and `app/api/billing/webhook/route.ts` (Stripe events). Paddle is retired.
- Usage pricing: quotas pool per billing account (`lib/usage/pool.ts`); past a quota only an `enforce` overage policy with an owner-set spend limit raises a cap (`lib/usage/overage.ts`). The limit is prepaid: it counts only up to what the owner paid in advance through Stripe Checkout (Cloud `lib/billing/prepay.ts`, `usage_prepayments`), Free has no limit at all, and each month's usage past the plan is drawn from that balance at the usage ledger's close (`lib/usage/`, Cloud `lib/billing/usage-charges.ts`). Rates live in `lib/pricing/catalog.ts`. `BACKENLY_OVERAGE_MODE` is `off|shadow|enforce`.
- AI usage tracked per user/month: `UserAiUsage` model
- Grace periods for overdue subscriptions: `lib/billing/grace.ts`

---

## Environment Variables

```bash
# Database
DATABASE_URL=postgresql://...     # Prisma primary
DIRECT_URL=postgresql://...       # Prisma direct (for migrations)
MONGODB_URI=mongodb://...         # Optional

# Auth
JWT_SECRET=                       # Platform session signing
JWT_EXPIRES_IN=7d
JWT_REFRESH_EXPIRES_IN=30d

# AI (lib/ai/llm/config.ts)
AI_PROVIDER=bedrock|anthropic|openai  # Unset: ANTHROPIC_API_KEY, then OPENAI_API_KEY. Bedrock is never inferred
BEDROCK_REGION=                       # With bedrock; credentials come from the AWS provider chain (ECS task role)
AI_MODEL=                             # Overrides the provider default; AI_MODEL_<PURPOSE> overrides one purpose
ANTHROPIC_API_KEY=
OPENAI_API_KEY=                       # The OpenAI provider, and embeddings for vector search
OPENAI_MODEL=                         # OpenAI only, with OPENAI_MODEL_FAST; AI_MODEL takes precedence
AI_TOTAL_MONTHLY_HARD_LIMIT_USD=      # Optional monthly cap on every AI call
AI_PLATFORM_MONTHLY_BUDGET_USD=       # Optional monthly cap on AI the deployment pays for itself (autonomy)

# App
NODE_ENV=development|production
NEXT_PUBLIC_APP_URL=http://localhost:3000

# Storage
STORAGE_DRIVER=local|s3
STORAGE_DIR=./uploads
STORAGE_S3_ENDPOINT=
STORAGE_S3_REGION=
STORAGE_S3_BUCKET=

# Email
SMTP_HOST=  SMTP_PORT=  SMTP_USER=  SMTP_PASS=  SMTP_FROM=
SUPPORT_NOTIFY_EMAIL=             # Optional: operator inbox emailed when support cases are filed (Cloud)

# OAuth
GOOGLE_CLIENT_ID=  GOOGLE_CLIENT_SECRET=  GOOGLE_REDIRECT_URI=
GITHUB_CLIENT_ID=  GITHUB_CLIENT_SECRET=  GITHUB_REDIRECT_URI=
REPLIT_CLIENT_ID=  REPLIT_CLIENT_SECRET=

# Payments (Stripe, Backenly Cloud only; a self-hosted install bills nobody)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_PRO_MONTHLY=
STRIPE_PRICE_PRO_ANNUAL=
BACKENLY_OVERAGE_MODE=off|shadow|enforce

# Security
AI_EXECUTION_TOKEN=               # Authorizes AI execution calls
BYPASS_AI_ENFORCEMENT=            # Testing only — never in prod
CRON_SECRET=                      # Authorizes cron job calls

# Optional
REDIS_URL=
SENTRY_DSN=
```

---

## Commands

```bash
# Development
npm run dev          # Starts Next.js + Express runtime server concurrently
npm run build        # prisma generate + next build
npm run lint         # ESLint

# Database (Prisma)
npm run db:generate  # Regenerate Prisma client after schema.prisma changes
npm run db:push      # Push schema to DB (no migration file — use in dev)
npm run db:migrate   # Create + apply migration (use when changes are intentional)
npm run db:studio    # Open Prisma Studio GUI

# Tests
npm test             # Setup test DB + run Jest
npm run test:watch   # Jest watch mode
npm run test:coverage
npx jest path/to/file.spec.ts    # Single file
```

---

## Self-Hosting / Deployment

There are TWO deployment contexts. Do not mix them.

### Backenly OSS / self-host

`npm run selfhost` is the supported OSS install path. It provisions the local
Docker dependencies and configures a single-project deployment. Self-hosters may
run the Node processes with their own process manager and may use local storage
or a supported S3-compatible provider.

Hostnames, credentials, proxy configuration and provider-specific secrets belong
in the operator's environment, never in this public repository.

### Backenly Cloud

Backenly Cloud no longer deploys from this repository directly and no longer
runs on Hetzner.

Cloud production/staging run on AWS. The private repositories are:

- `backenly/backenly-cloud` — add-only Cloud overlay, public SHA pin and release records.
- `backenly/backenly-infra` — Terraform for AWS staging/production.

Cloud runs Web/Runtime/PostgREST on ECS Fargate, PostgreSQL on RDS, persistent
volumes on EFS, native object storage on AWS S3 via IAM task roles, images in
ECR, secrets in Secrets Manager, and ingress through ALB/ACM.

For Cloud, NEVER deploy with SSH, `git pull` on a server, PM2, or
`scripts/deploy.sh`. The old Hetzner path is retired. Backblaze B2 is also
retired from Backenly Cloud; do not reintroduce B2 endpoints or static storage
credentials into Cloud configuration. This does NOT remove generic
S3-compatible storage support for OSS self-hosters.

Cloud source is composed from an exact pair:

```text
backenly/backenly       @ <public SHA>
backenly/backenly-cloud @ <cloud SHA>, with PUBLIC_BASE_SHA == <public SHA>
```

The AWS release is then performed from a known merged
`backenly/backenly-infra` SHA with immutable ECR digests and Terraform.
Staging qualification precedes production promotion. Release facts are recorded
in `backenly-cloud/releases/*.yml`.

See `.claude/rules/repository-workflow.md` for the durable Git/branch/release
rules that coding agents must follow.

### Required PostgreSQL configuration for self-host

One server-level setting is not optional if you want the full detector set:

```conf
shared_preload_libraries = 'pg_stat_statements'
```
```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

`docker-compose.dev.yml` and `docker/postgres-init/` configure this for the
supported self-host path. If a probe depends on a server capability, declare it
as `requires` rather than returning an empty healthy-looking result.

### Public-repository secret boundary

Nothing in this repo should contain a real production credential or private
Cloud infrastructure detail. `npx tsx scripts/preflight-oss.ts` enforces the
public-tree credential/host hygiene checks.

---

## Development Patterns & Conventions

### Adding a New Platform API Route

1. Create `app/api/<feature>/route.ts`
2. Wrap with `authenticateRequest` from `lib/auth/middleware.ts`
3. If project-scoped, also wrap with `withProjectValidation`
4. Add corresponding client function in `lib/api/<feature>.ts`

### Adding a New AI Action

1. Add the action type + its `case` handler in `lib/ai/minimal-executor.ts`
2. Expose it to the brain as a tool in `lib/ai/brain/tools.ts`
3. Add to executor vocabulary comments above
4. If destructive, add it to `DESTRUCTIVE_TOOLS` in `lib/ai/brain/tools.ts`, so
   the brain stops the call and queues it with its exact arguments
   (`lib/mcp/approvals.ts`); it runs only when a person approves that call

### Adding a New End-User Runtime Route

1. Create under `app/api/v1/[projectId]/<feature>/route.ts`
2. Authenticate using `project.jwtSecret` (NOT platform JWT)
3. All DB operations must target `workspace_{projectId}` schema

### Schema Changes

1. Edit `prisma/schema.prisma`
2. Run `npm run db:generate` to regenerate the client
3. Run `npm run db:migrate` (dev) or `npm run db:push` (quick)
4. On production: run both commands after `git pull`

### Writing Tests

- Tests live in `tests/`
- `npm test` sets up a test DB automatically
- Use real DB connections — do not mock the database (mocks have caused prod incidents)

---

## What NOT to Do

- **Never** add create/generate features outside the Database/AI chat section
- **Never** expose SQL **writes** or DDL — mutations go through typed actions so they stay planned, verified and reversible. SQL **reads** are supported and first-class (see below); do not "restore" a blanket raw-SQL ban.
- **Never** run DDL against a production workspace schema outside the change ledger, or destroy data in a schema change without preserving it (`lib/changes/preserve.ts`)
- **Never** let a SQL parser be the tenant boundary — read-only SQL runs as the project's SELECT-only `bkn_ro_` role so Postgres grants do the enforcing (`lib/mcp/read-query.ts`)
- **Never** mix platform user auth with end-user auth
- **Never** write directly to `workspace_{projectId}` schemas from platform Prisma — use `lib/services/workspaceDatabase.ts`
- **Never** skip `npm run db:generate` after editing `schema.prisma`
- **Never** use `BYPASS_AI_ENFORCEMENT=true` in production
- **Never** mock the database in tests

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

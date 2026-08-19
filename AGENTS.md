# AGENTS.md

Guidance for coding agents working in this repository. Read it fully before making changes.

This file follows the [AGENTS.md](https://agents.md) convention and is the single
source of truth; `CLAUDE.md` is a pointer to it. Keep it that way — this document
was previously duplicated, the two copies drifted, and a scrub applied to one of
them left the other still naming a production host.

---

## What is Backenly?

**Backenly** (live at https://backenly.com) is an **autonomous backend platform** that turns product descriptions into running backend infrastructure. It plans the backend, applies the infrastructure, verifies the runtime, and keeps every change reviewable and reversible. Developers describe their backend in natural language and Backenly automatically creates database tables, REST APIs, auth systems, storage, and more — no manual backend code required. (Category note: Backenly is **not** an "AI BaaS." It does not just generate resources — it manages backend change safely.)

**Tech Stack:** Next.js 14, React 18, Express.js, PostgreSQL (Prisma), MongoDB (optional), OpenAI API, Paddle payments, TailwindCSS, TypeScript throughout.

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

### 3. Feature Placement Rule (Do Not Violate)

> Only the **Database Management** section creates new backend reality (tables, APIs). All other sections (monitoring, auth settings, billing) manage *existing* reality.

**Never** add "quick create" or "AI generate" buttons outside the Database section. Creation happens there or through an agent over MCP.

---

## Project Structure

```
/
├── app/                          # Next.js app directory
│   ├── api/                      # ~234 API route handlers
│   │   ├── ai/chat/route.ts      # Main AI chat entry point
│   │   ├── ai-workspace/         # AI plan/apply/diff/detect routes
│   │   ├── auth/                 # Platform auth (login, OAuth, JWT)
│   │   ├── billing/              # Paddle subscription + AI usage
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

### Two-Brain Architecture

| Brain | File | Role |
|-------|------|------|
| Brain 1 | `lib/ai/brain/classifier.ts` | Classifies the turn once (BUILD / MODIFY / FIX / DESTRUCTIVE / QUESTION / CHAT) and routes it |
| Brain 2 | `lib/ai/minimal-executor.ts` | Converts intent graph into executable API calls (`CREATE_TABLE`, `GENERATE_API`, etc.) |

### Supporting Files

| File | Purpose |
|------|---------|
| `lib/ai/execution-engine.ts` | Orchestrates plan execution with MAX_STEPS + checkpointing |
| `lib/ai/brain/pending-destructive.ts` | Gates destructive operations behind user confirmation |
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
| `Subscription` + `PaddleSubscription` | Billing |
| `AuditLog` | Compliance audit trail |
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

## Billing (Paddle)

- Plans (internal code → display): SANDBOX → Free $0 · BUILDER → Pro $25/mo ($20 annual) · SCALE → Enterprise (custom, sales-led, no self-serve checkout) — seeded via `prisma/seed-billing.ts`. Internal codes are stable; only display names/prices/quotas change.
- Integration: `lib/billing/`, `app/api/billing/`
- Webhook: `app/api/billing/webhook/route.ts` (Paddle events)
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

# AI
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini

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

# OAuth
GOOGLE_CLIENT_ID=  GOOGLE_CLIENT_SECRET=  GOOGLE_REDIRECT_URI=
GITHUB_CLIENT_ID=  GITHUB_CLIENT_SECRET=  GITHUB_REDIRECT_URI=
REPLIT_CLIENT_ID=  REPLIT_CLIENT_SECRET=

# Payments (Paddle)
PADDLE_VENDOR_ID=
PADDLE_API_KEY=
PADDLE_PUBLIC_KEY=
PADDLE_WEBHOOK_SECRET=
PADDLE_PLAN_ID_PRO=
PADDLE_PLAN_ID_ENTERPRISE=
PADDLE_ENVIRONMENT=sandbox|production

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

Backenly runs as two Node processes behind a reverse proxy, against a
PostgreSQL instance you control:

| Process | What it serves |
|---------|----------------|
| Next.js | The dashboard UI and all platform APIs under `/app/api/` |
| Express runtime | The public end-user runtime, `/api/v1/*` (see `server/`) |

`docker-compose.yml` brings up the whole stack — both processes plus Postgres —
and is the supported way to run it. `ecosystem.config.js` is a PM2 alternative
for a plain VM.

### Deploying an update

`scripts/deploy.sh` is the single entry point. It pulls, syncs the Prisma schema
if `prisma/schema.prisma` changed anywhere in the pulled range, builds, restarts
the processes **only after `postbuild` completes**, and then health-checks.

```bash
# On the host, from the checkout:
git pull && bash scripts/deploy.sh
```

Prefer it over running the steps by hand — the ordering constraints below are
the ones people get wrong:

- **Never restart before `npm run build` (including `postbuild`) has finished.**
  `postbuild` copies static assets into the standalone output; restarting early
  serves a build with no CSS or JS.
- **Run `npm run db:generate` after any `schema.prisma` change**, before the
  build. A stale Prisma client fails at runtime, not at build time.
- **Pass `--update-env` when restarting** if `.env` changed, or the process
  keeps the old environment.

### Required PostgreSQL configuration

One server-level setting is not optional if you want the full detector set:

```conf
shared_preload_libraries = 'pg_stat_statements'   # postgresql.conf, needs a restart
```
```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

`docker-compose.dev.yml` and `docker/postgres-init/` do both for you. On a
database without it, `measured_slow_queries_are_indexed` cannot run —
`lib/autonomy/platform-capabilities.ts` detects that and the invariant is
reported as UNCHECKED (`DesiredStateReport.disabled`), never as satisfied.

If you add another probe that depends on a server-level capability, declare it
as `requires` on the invariant rather than returning `[]` when it is absent. An
empty result is indistinguishable from a healthy backend, which is how
`detectMissingRls` read green for months while it was dead.

### Host-specific configuration

Deployment details — hostnames, credentials, proxy config, log paths — belong in
your own environment, never in this repository. Configure them through `.env`
(see `.env.example`) and your process manager.

> Nothing in this repo should ever name a real host or hold a real credential.
> `npx tsx scripts/preflight-oss.ts` enforces that: it scans the working tree
> and the git history for credential shapes, public IP literals, session JWTs,
> and personal email addresses, and exits nonzero if it finds any.

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
4. If destructive, add it to `DESTRUCTIVE_TOOLS` in `lib/ai/brain/tools.ts` so
   `lib/ai/brain/pending-destructive.ts` gates it behind confirmation

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

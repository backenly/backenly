# MCP + Catalog-Truth Architecture

> How Backenly's agent-facing surface (MCP) and data plane work after the
> 2026-07-18 reliability + catalog-as-single-source-of-truth migration.
>
> Audience: anyone touching `lib/mcp/*`, `lib/ai/brain/*`, `server/routes/*`, or
> the v1 runtime. Read this before changing how tables become APIs.

---

## TL;DR

1. **The PostgreSQL catalog is the single source of truth** for "what the backend
   is." `ApiDefinition`, `BackendGraph`, and the `Table` metadata model are
   **derived projections / audit records — never authorities.**
2. **Every agent-facing read** (`list_tables`, `list_apis`, `read_backend_state`,
   `get_backend_metadata`, `get_table_schema`) derives from `information_schema` /
   `pg_catalog`, so it can never drift from the live schema.
3. **Auto-exposure**: any real, exposed workspace table is servable at
   `/api/v1/{projectId}/db/{table}` the instant it exists — no explicit
   `generate_api` step. `ApiDefinition` is lazily materialized on first request.
4. **Control plane vs data plane are separate layers.** The brain / autonomy /
   approvals / receipts (the moat) operate *on* the catalog; they don't hold a
   parallel truth.

This is the catalog-derived model ("data lives in PG; APIs are generated from
PG schema"), implemented natively on Backenly's existing Express runtime — no
PostgREST binary required (see [Roadmap](#roadmap)).

---

## The problem it solved: drift

Before this migration, "what tables/APIs exist" lived in **four** places that had
to be kept in sync by hand + an autonomy reconciler:

| Representation | Where | Failure it caused |
|---|---|---|
| Physical schema | `workspace_{projectId}` in Postgres | the real thing |
| `Table` model | `prisma.table` | `list_tables` showed a table the schema didn't have (and vice-versa) |
| `ApiDefinition` | `prisma.apiDefinition` | a table with no record 404'd even though it physically existed |
| `BackendGraph` | `prisma.backendGraph` | the brain planned against a stale schema ("posts — no columns yet") |

This is exactly the failure class the MCPMark benchmark names: *agents querying
columns/tables that no longer exist.* The whole autonomy "self-healing" loop spent
its time reconciling these copies — healing a problem the architecture created.

---

## The principle: catalog = single source of truth

- **Reads** derive from the live catalog. If it isn't in `information_schema`, it
  doesn't exist; if it is, it's real. No caching layer is treated as authority.
- **Writes** (DDL, RLS policies) land in Postgres — the one place truth lives.
- **Projections** (`ApiDefinition`, `Table`, `BackendGraph`) are rebuilt/derived
  from the catalog. They may exist for the dashboard or as an audit log, but no
  runtime or agent decision *gates* on them.

---

## Two-layer architecture

```
Control plane (governance):
  brain (lib/ai/brain/*) · autonomy MAPE-K (lib/autonomy/*) · approvals ·
  receipts · rollback · drift adoption
    └─ operate ON the catalog: issue DDL, set RLS policies, reconcile intent ─┐
                                                                              ▼
Data plane (reliability — catalog-derived):
  v1 runtime CRUD + RLS  ←  single source of truth = Postgres catalog
  (workspace_{projectId} schema, pg_catalog, RLS policies, NOT NULL/CHECK/FK)

Projections (derived, never authoritative):
  ApiDefinition · Table metadata · BackendGraph  → lazily materialized / audit
```

Same split every mature Postgres BaaS uses: a PostgREST-shaped data plane plus a
separate control plane (management API + auth service). Backenly's control plane
is the differentiator; the data plane is where the reliability comes from.

---

## Exposure model

Three predicates in [`lib/mcp/schema-introspection.ts`](../lib/mcp/schema-introspection.ts):

- **`isExposedTable(name)`** — visibility. Excludes `_`-prefixed plumbing
  (`_email_verifications`, `_token_blacklist`, …), `pg_*`, `spatial_ref_sys`.
  Used by `list_tables` / metadata: an exposed table is *visible* to the agent.
- **`isAuthManagedTable(name)`** — the auth identity table (`users`). It holds
  password hashes and is managed **only** via `/auth/*`. It stays **visible** in
  `list_tables`/metadata but is **never CRUD-exposed** (`/db/users` → 404) and
  **never auto-materialized** into an API. (Auth identity tables are kept out of
  the exposed API for this reason.)
- **`isCrudExposable(name)`** = `isExposedTable && !isAuthManagedTable` — a table
  an agent-built app may CRUD over `/db/<table>`.

**Security invariant:** `/db/users` must always 404. Enforced in
[`runtimeApiExecutor.ts`](../lib/services/runtimeApiExecutor.ts) *before*
`findApiDefinition`, so a stale `ApiDefinition` can't reach it.

---

## Auto-exposure: ApiDefinition as a lazy projection

The live `/db/{table}` path is `server/routes/dynamic.ts` →
`serverlessApiExecutor` → `runtimeApiExecutor.executeApiRequest` (NOT
`server/routes/database.ts` — that handler is not on the live path).

Flow when a request hits `/db/{table}`:
1. Block reserved / auth-managed tables → 404.
2. `findApiDefinition(projectId, table)`.
3. **If missing → `ensureApiDefinition(projectId, table)`** (in
   [`lib/services/apiDefinition.ts`](../lib/services/apiDefinition.ts)):
   - returns `null` for auth-managed or non-existent tables (→ 404),
   - otherwise verifies the table exists in the catalog (`workspaceTableExists`),
     upserts a `Table` projection (with `schema = workspace_{projectId}` — this
     field drives the CRUD schema qualifier), and creates the `ApiDefinition`
     projection with the **same config `executeGenerateAPI` produces** (full CRUD,
     `authStrategy: 'jwt'`, `v1`).
   - Idempotent + concurrency-safe (unique-violation → re-fetch).
4. Serve.

Net: **a real table is servable whether or not its API was ever explicitly
generated.** Only a genuinely non-existent / internal table 404s.

---

## Agent-context tools (the MCPMark lesson)

Added in `lib/ai/brain/tools.ts` + auto-surfaced in the MCP catalog
(`lib/mcp/catalog.ts`). All read the live catalog:

- **`get_table_schema { tableName }`** — columns (type/nullable/default/PK),
  foreign keys (+ON DELETE), indexes, CHECK constraints (with the *actual allowed
  values*), triggers, `rlsEnabled`/`forceRls` + live policies, exact record count.
- **`get_backend_metadata` / `get_project_overview`** — one call: every table with
  record count + column count + RLS + policy count, all FK relationships, and
  auth/storage/realtime/function state.
- **`get_instructions`** — read-first workflow primer (tool order, X-User-Token /
  RLS contract, runtime API shape, destructive-approval flow).

Read-before-write (`get_backend_metadata` → `get_table_schema`) is the golden
rule; it's what avoids FK/constraint/RLS guessing.

---

## Runtime contract (for agents building apps)

- Base: `https://backenly.com/api/v1/{projectId}`
- `x-api-key: sk_live_…` on every call.
- End-user auth: `POST /auth/signup` / `/auth/signin` → `{ token }`; send it as
  header **`X-User-Token`** on data calls — RLS then scopes rows to that user.
  (An API key alone is not a user; owner writes without a user token are denied on
  own-rows tables — correct.)
- CRUD `GET/POST/PUT/DELETE /db/<table>`, functions `/fn/<name>`, storage
  `/storage/*` (requires the project to be published).
- Owner maintenance / seeding: MCP `db_query/insert/update/delete` run as the
  project owner with the service-role RLS context (`app.is_service_role='true'`)
  and cast text params to strict PG types (uuid/json). Destructive DDL over MCP is
  refused → parked in the Review Queue → poll `check_approval`.

---

## Reliability fixes shipped alongside the migration (Batches 1–3)

`add_column` (was creating a column named `undefined`) · `db_*` RLS bypass +
uuid/json casts · `list_buckets` BigInt crash + a JSON-safe boundary guard ·
`list_end_users` (0-despite-real-users → service-role read) · generated functions
crashing on `{ params }` (runner now passes the Next route context) · `fetch_docs`
(fallback stub → reads `public/llms.txt` from disk) · `db_*` unified dispatch via
`/api/mcp/tool` · raw `P2010`/SQLSTATE → clean agent-actionable errors ·
`connect_frontend`/`set_env_var` reachable over MCP (`mcpOwnerConfirmed`) ·
truthful `backend_chat` timeout (reports what actually landed).

---

## Reliability benchmark

`scripts`-style harness drives the reliability-critical tasks (context, no-drift,
auto-expose, FK-valid insert, clean FK error, uuid filter, destructive-refused,
etc.) N times and reports **Pass^N** (strict — passes only if all N runs pass).
Post-migration: **11/11 Pass³ = 100%**, ~330–700ms median.

> Not the official 21-task MCPMark Pass⁴ vs the reference Postgres servers — a proxy that
> proves the drift/correctness failure class is eliminated. Porting the real
> MCPMark suite is a follow-up.

---

## Key files

| Concern | File |
|---|---|
| Exposure predicates + catalog introspection | `lib/mcp/schema-introspection.ts` |
| MCP tool catalog (auto-derived) | `lib/mcp/catalog.ts` |
| Brain tools + dispatch (reads → catalog) | `lib/ai/brain/tools.ts` |
| MCP data tools (owner CRUD, service-role, casts, clean errors) | `lib/mcp/runtime-db.ts` |
| Live CRUD executor + auto-exposure + `/db/users` block | `lib/services/runtimeApiExecutor.ts` |
| Lazy `ApiDefinition` materialization | `lib/services/apiDefinition.ts` (`ensureApiDefinition`) |
| Brain grounding read (catalog-truth) | `lib/ai/proof-system.ts` (`readTables`/`readApis`) |
| Autonomy: no "missing API" churn | `lib/core/drift-detector.ts` (`detectTablesWithNoApiDefinition` → `[]`) |
| Contract verifier probes CRUD-exposable table | `lib/services/contract-verifier.ts` |
| MCP HTTP surfaces | `app/api/mcp/*` |

---

## Backenly vs the standard Postgres-BaaS shape

| | Data plane | Control plane | Functions | Source of truth |
|---|---|---|---|---|
| **Typical Postgres BaaS** | PostgREST | management API + auth service | Deno | PG catalog |
| **Backenly** | native catalog-derived Express runtime | brain + autonomy (the moat) | route-module runner | PG catalog |

Same reliability property (single source of truth); Backenly's differentiator is
the autonomous control plane.

<a name="roadmap"></a>
## Roadmap

- **Now (shared cluster):** the native catalog-truth data plane above — full
  reliability without per-project infra. **DONE.**
- **Next (with per-project isolation):** swap the native data plane for
  **real PostgREST per project**. Inherits PostgREST's query language
  (embeds/filters/RPC) — the REST dialect agents already know;
  the control plane is untouched. Per-request logic (triggers, AI-function
  side effects, includes) moves to Postgres-native (triggers/RLS/RPC) + Deno-style
  functions — the standard Postgres-BaaS pattern.

### Known follow-ups (not done)
- Full 21-task MCPMark Pass⁴ port vs the reference Postgres servers.
- `backend_chat` loop *efficiency* (the ~90s over-run on big builds; the *lie* is
  already fixed — it reports what landed).
- Cosmetic: triplicated `status` enum in schema inference.
- One-time cleanup of any stale `users` `ApiDefinition` rows (runtime already
  blocks `/db/users` regardless): `DELETE FROM api_definitions WHERE name='users';`

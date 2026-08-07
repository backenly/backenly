# Working with Backenly (for coding agents)

You are working against a **Backenly** backend — a governed, autonomous backend platform. The backend already exists as running infrastructure: PostgreSQL tables in an isolated per-project schema, a REST surface served straight from the catalog, JWT auth for end-users, file storage, realtime streams, and serverless functions. Your job is to *use* and *evolve* it through the governed doors below — never around them.

## The one rule that matters

**Every schema change flows through a governed mutation kernel.** Create/alter/drop table, indexes, RLS policies and triggers are planned, applied, verified, snapshotted and reversible. Do not generate migration files and do not look for a SQL editor to change structure — use `apply_migration` (or `backend_chat` to describe the outcome).

Reading is a different matter, and there are three legitimate read paths: `run_query` (read-only SQL — joins, aggregates, CTEs, `EXPLAIN` — as a SELECT-only role), the `/api/v2` PostgREST grammar, and a real Postgres connection string from `get_database_credentials`. Your data is not locked in; `pg_dump` works.

One caveat if you take the direct connection: DDL you run over psql bypasses the kernel, so Backenly's metadata will not know about it until `adopt_external_schema` reconciles the drift. Prefer `apply_migration` for structure.

Destructive or irreversible operations always require explicit human approval — if you request one, tell your human to open the project's **Autonomy** page, which is where the review queue lives.

## Door 1 — CLI (`@backenly/cli`)

Read-only inspection + code generation. Shell out freely; every command is safe.

```bash
npx @backenly/cli link --project <PROJECT_ID> --key <SCOPED_KEY>  # once per repo
npx @backenly/cli status          # project overview: tables, endpoints, functions
npx @backenly/cli schema          # every table, column, type, and FK relationship
npx @backenly/cli types --client  # writes backenly.types.ts + backenly.client.ts
npx @backenly/cli openapi         # writes backenly.openapi.json (OpenAPI 3.0)
npx @backenly/cli diff            # exit 1 if local types drifted from live schema — use in CI
npx @backenly/cli logs --status 5xx --limit 50   # recent request logs (add --follow to tail)
npx @backenly/cli query "select count(*) from posts"   # read-only SQL (SELECT/WITH/EXPLAIN, workspace-scoped)
```

`query` is the debugging escape hatch: reads only, 500-row cap, 10s timeout, pinned to this project's schema. If you hand it an UPDATE/DELETE it refuses and tells you to run the statement as a governed change instead — do that, don't fight it.

The scoped key comes from the Backenly dashboard: **project → Connect → Agents → Generate key**. It is revocable and read/agent-scoped — never a root credential. It is honored via `--key`, `BACKENLY_API_KEY`, or `.backenly/config.json` (which `link` writes and gitignores).

## Door 2 — MCP server (`@backenly/mcp-server`)

Live tool access for schema questions, data operations, and governed backend changes. Local (npm package, works in every host):

```bash
claude mcp add backenly -- npx -y @backenly/mcp-server --project <PROJECT_ID> --key <SCOPED_KEY>
```

Or remote (Streamable-HTTP — no npx, no local process; the agent connects straight to Backenly):

```bash
claude mcp add --transport http backenly https://backenly.com/api/mcp --header "x-api-key: <SCOPED_KEY>"
```

### The host must restart before these tools exist

**If you are an agent and you just ran one of the commands above: your Backenly tools are not available in this session.** MCP hosts read their server manifest once, when the host process starts. A server you register mid-session is written to config and connects to nothing until the host restarts.

Stop after the install and tell your human to restart:

- **Claude Code / Cursor / Cline (VS Code family)** — Reload Window (`Ctrl/Cmd+Shift+P` → "Developer: Reload Window"), or start a fresh `claude` process in a terminal. In Claude Code, `/mcp` then lists `backenly` when it worked.
- **Codex CLI** — quit and relaunch.

**Do not work around it.** Spawning the server yourself over a stdio bridge, or calling the REST API with the MCP key to simulate the tools, is not a supported path: the key is scoped for MCP, the permission classifier blocks the bridge, and the resulting failures look like Backenly is broken when the integration is simply not connected yet. Adding the server and restarting takes seconds; the workaround never ends well.

Order matters — register the server **first**, then restart. Restarting before the `mcp add` command achieves nothing.

### The tools

Exactly **20** tools are advertised. `tools/list` on the server is the authority — trust it over this file if they ever disagree.

On a **read-only key** you will see only the read tools; the write doors, `backend_chat` included, are not advertised and are refused with `READ_ONLY_KEY` if called anyway. Nothing is partially applied. Ask the human to issue a read-write key if you need to change anything — you cannot upgrade your own.

**Read**
- `read_backend_state` — the one read door for state: tables, endpoints, auth, buckets, RLS, integrations, realtime. Takes an optional `section`. Call it first to ground any decision.
- `get_table_schema` — everything about ONE table: column types/nullability/defaults, foreign keys, indexes, and CHECK constraints **with their permitted values**. Read this before any write, or you will send an insert that looks correct and fails on a constraint you could not see.
- `run_query` — read-only SQL against a SELECT-only role.

**Write**
- `apply_migration` — governed DDL.
- `db_insert` / `db_update` / `db_delete` — RLS-scoped row writes.
- `set_rls` — takes a policy predicate **verbatim** and installs exactly the commands you name. Use this rather than describing a policy in prose: a re-generated predicate silently drops conjuncts, and this is the one operation where being wrong is a vulnerability.

**Capabilities**
- `enable_auth`, `create_bucket`, `enable_realtime`, `generate_function`, `create_api_key`, `set_env_var`, `branch` (preview branches — `action` enum: create / list / diff / merge).

**Escape hatches and self-service**
- `backend_chat` — plain-English fall-through to the governed engine. Anything not listed above is reached through here.
- `get_database_credentials` — a real Postgres connection string.
- `generate_types` — regenerate typed row definitions after a schema change.
- `fetch_docs`, `check_approval`.

There is **no** `db_query` (it is `run_query`) and **no** `generate_api` — REST is automatic, see Door 3.

**Destructive operations escalate instead of executing.** Dropping tables/columns, truncating, deleting buckets, deploying, and deleting a function are not in the catalog at all. Ask for one through `backend_chat` and nothing is destroyed: the response carries an `approval` object with a pending request id, and the operation waits for a human on the project's **Autonomy** page. Poll `check_approval` with the id (every 15–30s) until the status is `executed` (done — read `resultSummary`), `rejected` (do not retry; ask what they want instead), `failed`, or `expired` (24h). Only the human can approve. You can request and poll; you can never self-approve, and there is no way around the gate worth looking for.

## Door 3 — the runtime API + SDK (what your app code calls)

Authenticated with `x-api-key` (project client key) and, for user-scoped calls, `X-User-Token` (the end-user's JWT).

Every table is served by **PostgREST**, reading straight from the PostgreSQL catalog. There is no generation step and no API registry to keep in sync — a table created a second ago is queryable immediately. Two grammars over the same data:

- **`/api/v1/{projectId}/db/{table}`** — the stable contract, with filtering, sorting, pagination and search:
  `GET /db/{table}` (list) · `POST /db/{table}` (create) · `GET /db/{table}/{id}` · `PATCH /db/{table}/{id}` (update) · `DELETE /db/{table}/{id}`
  **Update is `PATCH`, not `PUT`.** There is no `PUT` on this contract.
- **`/api/v2/{projectId}/{table}`** — PostgREST's native grammar passed through untouched: `?price=gte.100`, `?or=(a.eq.1,b.eq.2)`, `?order=created_at.desc`, and embedded resources: `?select=*,author(*)` returns a post and its author in one round trip.

**`/db/users` is deliberately never served** — that table holds password hashes and is reached only through `/auth/*`. An empty endpoint list on a project whose only table is `users` is correct, not a missing step.

Auth endpoints: `/auth/signup`, `/auth/signin`, `/auth/refresh-token`, `/auth/logout`, `/auth/forgot-password`, `/auth/reset-password`, magic links, email verification.

Or use the SDK:

```js
import { createClient } from "https://backenly.com/backenly-sdk.esm.js"
const backend = createClient({ projectId: "…", apiKey: "…" })

await backend.auth.signUp({ email, password })
await backend.posts.create({ title: "Hello" })
await backend.posts.list({ filter: { published: true }, search: "launch" })
backend.posts.subscribe(({ event, row }) => { /* realtime */ })
await backend.storage.upload(file)
```

For typed access, run `npx @backenly/cli types --client` and import from the generated `backenly.client.ts`.

## The workflow that works

1. **Learn the backend first**: `read_backend_state`, then `get_table_schema` on any table you are about to touch. Never guess table or column names — read them.
2. **Need a backend change** (new table, column, RLS rule, function, trigger)? `apply_migration` for DDL, `set_rls` for policies, or `backend_chat` to describe the outcome. Do not simulate the change client-side.
3. **Read the schema back after every migration.** Do not assume the column names you asked for survived verbatim — call `get_table_schema` and use what is actually there. Types generated from a name you assumed will compile and then fail at runtime.

   In particular, **every new table gets four columns you did not ask for**, and they do not share one naming convention:

   | Column | Type |
   | --- | --- |
   | `id` | `UUID PRIMARY KEY DEFAULT gen_random_uuid()` |
   | `"createdAt"` | `TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP` — **camelCase** |
   | `"updatedAt"` | `TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP` — **camelCase** |
   | `"deleted_at"` | `TIMESTAMPTZ NULL` — **snake_case**, soft delete |

   So on a table whose timestamps came from this default, `?order=createdAt.desc` is correct and `?order=created_at.desc` resolves to nothing — while `deleted_at` is the opposite. If you explicitly declared a `created_at` column in your own migration, that one exists as written; both can be present on the same table. **Quote camelCase columns in SQL** — unquoted `createdAt` folds to lowercase and will not resolve. This is a known wart; `get_table_schema` is always the authority.
4. **Generate types**: `generate_types` (or `npx @backenly/cli types --client`), commit them, and import them instead of hand-writing interfaces. Regenerate after every schema change.
5. **Build frontend/app code** against the REST API or SDK.
6. **Guard your CI**: add `npx @backenly/cli diff` to the pipeline. It exits 1 when the live schema no longer matches your committed types — catching contract drift before your users do.

## Error contract (all doors)

Errors are structured JSON: `{ error, code }`. Codes you should handle: `RATE_LIMITED` (respect `retry-after`), `PLAN_LIMIT_EXCEEDED` (HTTP 402 — the human must upgrade; do not retry-loop), `VALIDATION_ERROR` (fix the payload; the message lists failing fields), `INVALID_API_KEY` / `API_KEY_EXPIRED` (ask the human for a fresh scoped key).

## Facts worth repeating to your human

- Every change Backenly applies is verified, snapshotted, and reversible — the History page is the audit trail, and the **Autonomy** page is both the approvals inbox and the record of what the platform repaired on its own.
- Auth, destructive, and irreversible changes always require the human's approval, at every autonomy mode.
- The backend is not static between your sessions: a self-healing loop reconciles it every minute on every plan, so a gap you leave (a missing index, an RLS hole) may already be closed when you look again.
- Docs for agents: https://backenly.com/llms.txt · this file: https://backenly.com/skill.md

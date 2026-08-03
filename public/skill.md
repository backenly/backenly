# Working with Backenly (for coding agents)

You are working against a **Backenly** backend — a governed, autonomous backend platform. The backend already exists as running infrastructure: PostgreSQL tables in an isolated per-project schema, generated REST endpoints, JWT auth for end-users, file storage, realtime streams, and serverless functions. Your job is to *use* and *evolve* it through the governed doors below — never around them.

## The one rule that matters

**Backenly has no raw-SQL write surface, by design.** Every schema change (create/alter/drop table, indexes, RLS policies, triggers) flows through a governed mutation kernel that plans, applies, verifies, snapshots, and can roll back the change. Do not try to connect to Postgres directly, do not generate migration files, do not look for a SQL editor. Destructive or irreversible operations always require explicit human approval in the Backenly dashboard — if you request one, tell your human to check their Review Queue.

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

Tools you get: `backend_chat` (describe any backend change in plain English — the governed engine plans and executes it), `db_query` / `db_insert` / `db_update` / `db_delete` (RLS-scoped data access), `check_approval`, `fetch_docs`.

**Destructive operations escalate instead of executing.** If your `backend_chat` request involves dropping tables/columns or deleting buckets, nothing is destroyed: the response carries an `approval` object with a pending request id, and the operation waits in the project's **Review Queue**. Tell your human to approve or reject it in the Backenly dashboard, then poll `check_approval` with the id (every 15–30s) until the status is `executed` (done — read `resultSummary`), `rejected` (do not retry; ask what they want instead), `failed`, or `expired` (24h). Only the human can approve — never try to work around the gate.

## Door 3 — the runtime API + SDK (what your app code calls)

Base URL: `https://backenly.com/api/v1/{projectId}` — authenticated with `x-api-key` (project client key) and, for user-scoped calls, `X-User-Token` (the end-user's JWT). Every table gets `GET/POST/PUT/PATCH/DELETE` REST endpoints plus filtering, sorting, pagination, and search. Auth endpoints: `/auth/signup`, `/auth/signin`, `/auth/refresh-token`, `/auth/logout`, `/auth/forgot-password`, `/auth/reset-password`, magic links, email verification.

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

1. **Learn the backend first**: `backenly status` then `backenly schema`. Never guess table or column names — read them.
2. **Generate types**: `backenly types --client`, commit both files, and import them instead of hand-writing interfaces.
3. **Build frontend/app code** against the REST API or SDK.
4. **Need a backend change** (new table, column, RLS rule, function, trigger)? Use MCP `backend_chat` and describe the outcome you want — or tell your human what to ask the Backenly agent in the dashboard. Do not simulate the change client-side.
5. **Guard your CI**: add `npx @backenly/cli diff` to the pipeline. It exits 1 when the live schema no longer matches your committed types — catching contract drift before your users do.

## Error contract (all doors)

Errors are structured JSON: `{ error, code }`. Codes you should handle: `RATE_LIMITED` (respect `retry-after`), `PLAN_LIMIT_EXCEEDED` (HTTP 402 — the human must upgrade; do not retry-loop), `VALIDATION_ERROR` (fix the payload; the message lists failing fields), `INVALID_API_KEY` / `API_KEY_EXPIRED` (ask the human for a fresh scoped key).

## Facts worth repeating to your human

- Every change Backenly applies is verified, snapshotted, and reversible — the History page is the audit trail, the Review Queue is the approvals inbox.
- Auth, destructive, and irreversible changes always require the human's approval, at every autonomy mode.
- Docs for agents: https://backenly.com/llms.txt · this file: https://backenly.com/skill.md

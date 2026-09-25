# Working with Backenly (for coding agents)

You are working against a **Backenly** backend: a governed, autonomous backend platform. The backend is running infrastructure already: PostgreSQL tables in an isolated per-project schema, a REST surface served from the catalog, JWT auth for end-users, file storage, realtime and functions. Your job is to use and evolve it through the governed doors below, never around them.

## The one rule that matters

**Every structural change goes through a governed kernel.** Tables, columns, indexes, RLS policies and triggers are planned, applied, verified, snapshotted and reversible. Do not write migration files and do not look for a SQL editor: use `apply_migration`, or describe the outcome to `backend_chat`.

Reading is different. There are three legitimate read paths: `run_query` (read-only SQL as a SELECT-only role), the `/api/v2` PostgREST grammar, and a real Postgres connection string from `get_database_credentials`. DDL you run over a direct connection bypasses the kernel; reconcile it afterwards with `adopt_external_schema`.

Destructive or irreversible operations always need a human's approval on the project's **Autonomy** page.

## Getting connected

The human generates a scoped key at **project → Connect → Agents**. It is bound to one project and revocable.

**MCP (preferred for the long run).** Register it in a terminal before the conversation starts:

```bash
claude mcp add backenly -- npx -y @backenly/mcp-server --project <PROJECT_ID> --key <SCOPED_KEY>
```

Or remote, with no local process: `claude mcp add --transport http backenly https://backenly.com/api/mcp --header "x-api-key: <SCOPED_KEY>"`. Without the header, `/mcp` → Authenticate signs in through the browser instead.

**If you registered it during this conversation, the MCP tools are not here yet**: hosts read MCP config when a conversation starts. Do not stop and ask for a restart. Keep working through the CLI, which calls the same tools with the same key:

```bash
npx -y @backenly/cli@latest link --project <PROJECT_ID> --key <SCOPED_KEY>
npx -y @backenly/cli@latest tools                                  # what you can call
npx -y @backenly/cli@latest call read_backend_state                # any tool, key=value args
npx -y @backenly/cli@latest call get_table_schema tableName=posts
npx -y @backenly/cli@latest call apply_migration sql="ALTER TABLE posts ADD COLUMN likes integer DEFAULT 0"
npx -y @backenly/cli@latest chat "add comments to posts"           # backend_chat
```

Nested JSON arguments go in a file (`--args-file args.json`) or on stdin (`--args -`); PowerShell strips inline quotes. Exit code 1 means Backenly said `ok: false`. The MCP tools appear in the next conversation: a new tab in the Claude Code VS Code extension, or `/exit` then `claude --continue` in a terminal.

Never spawn the MCP server yourself or imitate the tools with curl. The CLI is the supported path.

## The tools

Exactly **23** are advertised over MCP; `tools/list` (or `backenly tools`) is the authority.

- **Read**: `read_backend_state` (call it first; `section` drills into `schema`, `users`, `functions`, `integrations`, `metrics`, `deploy`, `autonomy` and more), `get_table_schema` (columns, FKs, CHECK constraints with their permitted values, RLS; read it before any write), `run_query`.
- **Write**: `apply_migration` (DDL), `db_insert` / `db_update` / `db_delete` (row writes as the owner; they bypass end-user RLS, so use them for seeding and repair, not to simulate a user), `set_rls` (a policy predicate installed verbatim; prefer it to describing a policy in prose).
- **One tool per dashboard section**, each with an `action` its description lists: `auth`, `storage`, `functions` (Backenly writes the code from your spec), `realtime`, `integrations`, `monitoring`, `autonomy`, `webhooks`, `deploy`, `connect`, plus `branch` (preview branches: list / create / diff / merge).
- **Everything else**: `backend_chat` (plain English; draws AI credits), `generate_types`, `fetch_docs`, `check_approval`.

Older tool names that are no longer advertised still run by name through `backenly call` (for example `enable_auth`, `create_bucket`, `set_env_var`). REST is automatic: `/db/<table>` exists the moment the table does, so there is no API-generation step.

**Destructive operations escalate instead of executing.** Deploying, rolling back, deleting buckets or functions, revoking keys: call the domain action (`deploy { action: "deploy" }`, `functions { action: "delete" }` …) and the exact call is parked. Dropping or truncating a table: ask through `backend_chat`. Either way the response carries an `approval` id and nothing is changed until a human approves it on the Autonomy page; an approved domain call runs verbatim. Poll `check_approval` every 15–30s: `executed` (done), `rejected` (do not retry), `failed` (nothing applied), `partial` (some changes landed; verify, do not replay), `expired`.

## Integrations

Stripe, Resend, OpenAI, Anthropic and PostHog all connect from an agent. The key is verified with the provider before it is stored. Either the human pastes it on the Integrations page (keeps it out of the conversation) or you pass it: `integrations { action: "connect", integrationId: "stripe", apiKey: "sk_test_…", webhookSecret: "whsec_…" }`. Never put a provider key in app code. Functions reach providers as `ctx.integrations.stripe`, `.resend`, `.openai`, `.anthropic`, `.posthog`.

Stripe events arrive at `/api/v1/{projectId}/webhooks/stripe`, which verifies the signature and rejects everything until the signing secret is stored. The human must paste that URL into the Stripe dashboard; no provider API can do it for them.

## The runtime API (what your app calls)

Two headers: `x-api-key: <project key>` on every request, and `X-User-Token: <end-user JWT>` for anything RLS protects. Never send the project key as `Authorization: Bearer`; the runtime parses that header as a JWT and answers 401.

- `/api/v1/{projectId}/db/{table}`: `GET` (list), `POST`, `GET /{id}`, `PATCH /{id}` (`PUT` is accepted as the same update), `DELETE /{id}`.
- `/api/v2/{projectId}/{table}`: PostgREST grammar: `?price=gte.100`, `?order=createdAt.desc`, `?select=*,author(*)`.
- `/auth/signup`, `/auth/signin`, `/auth/refresh-token`, `/auth/logout`, `/auth/forgot-password`, `/auth/reset-password`, `/auth/me`, magic links, OAuth, email verification.
- `/db/users` is never served; users live behind `/auth/*`.

SDK: `npm install @backenly/sdk`, then `createClient({ projectId, apiKey })`.

## The workflow that works

1. `read_backend_state`, then `get_table_schema` on anything you will touch. Never guess names.
2. Change structure with `apply_migration` / `set_rls`, or `backend_chat` for the outcome.
3. Read the schema back after every migration. **Every new table gets four columns you did not ask for:** `id` (uuid), `"createdAt"` and `"updatedAt"` (camelCase), `"deleted_at"` (snake_case). Order by `createdAt`, filter soft deletes on `deleted_at`, and quote camelCase names in SQL. A `created_at` or `updated_at` you declare in `CREATE TABLE` is skipped in favour of these.
4. `generate_types` (or `backenly types --client`), commit the output, regenerate after every schema change. `backenly diff` in CI fails when they drift.
5. Build the app against the REST API or SDK.

## Errors

Structured JSON: `{ ok: false, error, code }`. `RATE_LIMITED`: respect `retry-after`. `PLAN_LIMIT_EXCEEDED` / `AI_CREDITS_EXHAUSTED`: the human must act; do not retry in a loop (only `backend_chat` and `generate_function` spend credits). `READ_ONLY_KEY`: ask for a read-write key. `INVALID_KEY` / `NO_AUTH`: ask for a fresh key from Connect → Agents.

## Worth telling your human

- Every change is verified, snapshotted and reversible; the History page is the audit trail and the Autonomy page is the approvals inbox.
- The backend is not static between sessions: the autonomy loop repairs what it safely can on every plan, so a gap you leave may already be closed next time.
- Full docs: https://backenly.com/llms.txt · this file: https://backenly.com/skill.md

# @backenly/mcp-server

Plug **[Backenly](https://backenly.com)** into Claude Code, Cursor, Codex, Cline, and Claude Desktop over the [Model Context Protocol](https://modelcontextprotocol.io).

```sh
claude mcp add backenly -- npx -y @backenly/mcp-server \
  --project <projectId> --key mcp_live_...
```

Restart your host, done. Your AI host now has governed agentic access to your Backenly backend.

## What you get

Eighteen advertised tools, not sixty. The catalog is an allowlist admitted on one
rule — *is there exactly one tool here that answers a given request?* — because
tool-selection accuracy degrades with catalog size and models misfire hardest
between similarly-named tools. Everything else is reached through `backend_chat`.
Unlisted tools stay dispatchable, so clients pinned to an older manifest keep
working.

### `backend_chat` — say what you want

```
> Add comments and likes to my posts table
```

The host LLM hands the request to Backenly's brain. Brain plans, executes, and returns a summary. The host LLM never has to learn a vocabulary.

### Read

- `read_backend_state` — the single read-state door. Call with no arguments for the grounding overview; pass `section` (`schema`, `tables`, `apis`, `rls`, `metrics`, `errors`, `deploy`, `usage`, `autonomy`, …) to drill in. It replaces the ~26 `list_*` / `get_*` tools, which remain dispatchable.
- `run_query` — standard read-only SQL over your workspace schema: joins, `GROUP BY`, aggregates, window functions, CTEs, `EXPLAIN`. Runs as a SELECT-only Postgres role scoped to the project, so isolation is a database grant rather than a parser. Secret-bearing columns come back redacted.
- `fetch_docs` — pull current Backenly docs instead of guessing.
- `check_approval` — poll an escalated destructive request.

### Write

- `apply_migration` — ordinary PostgreSQL DDL (`CREATE TABLE`, `ALTER TABLE`, `CREATE INDEX`), translated statement by statement into governed actions. All-or-nothing; anything it cannot govern is refused with the tool to use instead. Not raw SQL execution.
- `db_insert` / `db_update` / `db_delete` — row writes. Owner-level: validates shapes but bypasses end-user RLS and triggers, so treat them as maintenance tools.

### Capabilities

`enable_auth`, `create_bucket`, `generate_api`, `generate_function`, `enable_realtime`, `create_api_key`, `set_env_var` — the things no SQL statement expresses. Plus `get_database_credentials` (direct Postgres, read-write only after a human arms it) and `adopt_external_schema` (reconcile drift you made outside Backenly).

### Resources (11)

Browse live state without spending a tool call:

```
backenly://state         Full backend state
backenly://tables        Table list + counts
backenly://apis          REST endpoints
backenly://buckets       Storage buckets
backenly://triggers      Event triggers
backenly://rls           RLS policies
backenly://functions     AI functions
backenly://deploy        Deploy status
backenly://metrics       Performance metrics
backenly://errors        Recent errors
backenly://usage         Plan usage
```

## Setup

Generate a scoped key from **[backenly.com](https://backenly.com)** → your project → **Connect → Agents**. It starts with `mcp_live_`, only works on MCP routes, and is revocable from the same page.

**Claude Code / Codex** — one command:

```sh
claude mcp add backenly -- npx -y @backenly/mcp-server \
  --project <projectId> --key mcp_live_...
```

**Cursor** (`.cursor/mcp.json`), **Cline** (`cline_mcp_settings.json`), **Claude Desktop** — same server block:

```json
{
  "mcpServers": {
    "backenly": {
      "command": "npx",
      "args": [
        "-y", "@backenly/mcp-server",
        "--project", "<projectId>",
        "--key", "mcp_live_..."
      ]
    }
  }
}
```

Prefer to keep the key out of a file you might commit? Run the installer once —
it verifies the key, writes `~/.backenly/mcp.json` (mode 0600), and prints config
snippets. The host block then needs no key at all.

```sh
npx @backenly/mcp-server init
```

Restart your host. Backenly appears as a tool surface.

## How it works

```
Host LLM (Claude Code, Cursor, ...)
   │ stdio JSON-RPC
   ▼
@backenly/mcp-server (this package)
   │ HTTPS + x-api-key + x-correlation-id
   ▼
backenly.com — brain, executor, runtime APIs
```

The package contains **zero business logic** — it's a thin protocol adapter. Tool definitions, billing, rate limiting, and audit logging all live server-side. New brain tools appear in your host immediately without `npm update`.

## Reliability

- **Retry** — network errors and `502/503/504` retry with exponential backoff (250ms / 1s / 3s + jitter), honoring `Retry-After`.
- **Boot health check** — `/api/mcp/health` runs before manifest fetch so auth failures surface in <1s.
- **Graceful shutdown** — SIGINT/SIGTERM close the transport cleanly so MCP hosts don't see corrupt frames.
- **Correlation IDs** — every request carries `x-correlation-id` for distributed tracing.

## Security

- MCP keys (`mcp_live_…`) are **scope-gated** — `/api/mcp/*` rejects `runtime` SDK keys. A leaked SDK key cannot be replayed against MCP to drop tables.
- **Destructive tools are not exposed.** `drop_table`, `delete_bucket`, `truncate_table`, etc. are never executed from MCP. Ask for one via `backend_chat` and it parks in the project's **Review Queue** and returns an approval id; a human decides in the dashboard and you poll `check_approval` until it is executed or rejected. The agent cannot self-approve.
- **Plan quota** is enforced per request via `enforceAndTrackApiRequest`. Hitting your plan cap returns 429.
- **Per-key rate limit** — sliding-window using `ApiKey.rateLimit` / `rateLimitWindow`. 429 includes `Retry-After` + `X-RateLimit-*` headers.
- **Audit log** — every mutation through MCP writes an `AuditLog` row on your project timeline.
- **Local config** is written with `0600` permissions (user-only readable).
- **Revoke any key** anytime from your project's Connect → Agents page.

## Environment

| Variable           | Default                | Notes                              |
| ------------------ | ---------------------- | ---------------------------------- |
| `BACKENLY_API_KEY` | from `~/.backenly/mcp.json` | Override key (CI / multiple projects). |
| `BACKENLY_API_URL` | `https://backenly.com` | Self-hosted Backenly endpoint.     |

## CLI

```sh
npx @backenly/mcp-server init              # interactive setup
npx @backenly/mcp-server init -k <key>     # setup with API key flag
npx @backenly/mcp-server                   # run as MCP server (stdio)
npx @backenly/mcp-server health            # verify the configured key
npx @backenly/mcp-server version
npx @backenly/mcp-server help
```

## Troubleshooting

**"This key has scope='runtime'"** — you pasted your SDK anon key. Generate a separate MCP key from the project's Connect → Agents page.

**"Could not reach Backenly"** — check your internet or set `BACKENLY_API_URL` if self-hosting.

**Host shows "MCP server crashed"** — run `npx @backenly/mcp-server health` to verify the key. Check `~/.backenly/mcp.json` exists and has mode 0600.

**Rate-limited (429)** — your MCP key hit its per-minute cap. Default is 600/min; raise it from the dashboard or wait until `X-RateLimit-Reset`.

## License

MIT — see [LICENSE](LICENSE).

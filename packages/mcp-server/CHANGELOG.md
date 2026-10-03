# Changelog

All notable changes to `@backenly/mcp-server` are documented here. Follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-09-26

### Changed
- **Built on the official MCP SDK v2** (`@modelcontextprotocol/server`), replacing `@modelcontextprotocol/sdk` v1. One server now serves both protocol eras: 2025-era hosts that open with `initialize`, and 2026-07-28 hosts that open with `server/discover`. A catalog that loads after boot reaches either kind of host (`notifications/tools/list_changed`, or the host's `subscriptions/listen` stream).
- **Node.js 20 or newer is required**, as the SDK requires.
- **Tool results are the server's own body**, as `structuredContent` and as JSON text, the shape the remote endpoint returns. A failure used to reach the agent as one sentence, and over a 4xx the server's `hint`, `applied` and trail of what ran were dropped. A failure now also carries a text block saying what its fields mean for the next step (what already landed, whether a retry can help).
- **`db_query`, `db_insert`, `db_update` and `db_delete` go through `/api/mcp/tool`**, as they do over the remote endpoint, instead of `/api/mcp/db/*`, which answer in a different shape. The server validates their arguments there with the same schemas as `/api/mcp/db/*`, so a bad call is refused the same way on every surface (needs a Backenly release that includes it).
- **Instructions and resources come from the manifest** (manifest 1.1.0), so they match the remote endpoint's. The package keeps its own copies for a server that does not send them.
- Unknown resources are refused as invalid params (`-32602`) naming the URI.

### Added
Also first published in this release: 0.3.3 was versioned in #117 and never published.
- **A catalog that failed to load at boot is retried** in the background, and the host is told the tool list changed once it loads. It used to be fetched once, leaving the session on the three fallback tools for its whole life.
- **Tools carry MCP annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) and a `title`, from the manifest.

### Fixed
- `init` says to open a new conversation, not to restart the host: hosts read MCP config when a conversation starts.

## [0.3.1] — 2026-07-25

### Fixed
- **`toolsRun` and `iterations` are no longer invented.** They were defaulted with `?? []` and `?? 0`, and the server's partial-result path did not send them — so a real response read `{ applied: ["Securing profiles · custom RLS"], partial: true, toolsRun: [], iterations: 0 }`. A change applied by zero tools in zero iterations is not a fact anybody measured; it made the response unauditable. Absent now means absent.

### Added
- **`verified`** is forwarded on partial results, so an agent can tell a verified partial from an unverified one without reading prose. Backenly now holds back a verification reserve and stops taking new steps while it remains, so a partial result normally arrives verified; only the transport's hard wall clock produces `verified: false`.
- **`verifyWith`** is forwarded alongside it — the specific thing to re-check, rather than an invitation to audit the whole backend.

## [0.2.1] — 2026-07-22

### Changed
- **Connection greeting** — the server now sends MCP `instructions` on connect. Hosts that surface them (Claude Code, etc.) inject the brief into the agent's context, so instead of the connection landing silently the agent confirms "Backenly is connected to `<project>`", says what it can build, and asks what you'd like to do. The brief also grounds the agent: read `backenly://state` before changing anything.
- Boot-time stderr line now reads `connected to Backenly — project <name>` rather than `healthy — project <name>`.

## [0.1.0] — 2026-05-25

Initial release.

### Features
- **Tier-1 mega-tool** — `backend_chat` runs natural-language requests through Backenly's agentic brain.
- **Read tools (21)** — list tables, APIs, buckets, RLS policies, end-users, deploys, metrics, errors, autonomy state, realtime status, webhook deliveries, integrations, env vars.
- **Build tools (25+)** — `create_table`, `add_column`, `generate_api`, `enable_auth`, `add_oauth_provider`, `add_rls`, `create_trigger`, `enable_realtime`, `generate_function`, `enable_vector_search`, `create_cron_job`, `set_rate_limit`, `enable_teams`, `send_push`, `rotate_webhook_secret`, `connect_frontend`, and more.
- **Runtime data CRUD** — `db_query`, `db_insert`, `db_update`, `db_delete` for workspace rows.
- **Resources** — 11 MCP resources (`backenly://state`, `backenly://tables`, `backenly://apis`, etc.) for state browsing.
- **Dynamic catalog** — tools are fetched from `/api/mcp/manifest` at startup; new Backenly brain tools appear in your host without updating this package.

### Reliability
- HTTP retry with exponential backoff (250ms / 1s / 3s + jitter) on network errors and `502/503/504` for POSTs. GET retries on any 5xx.
- Honors `Retry-After` headers.
- Graceful shutdown on SIGINT / SIGTERM — closes the transport cleanly so MCP hosts don't see a half-written JSON-RPC frame.
- Boot-time `/health` check surfaces auth failures in <1s.

### Security
- Scope-gated keys (`mcp_live_…`). Refuses to authenticate with `runtime` SDK keys.
- Destructive operations (`drop_table`, `delete_bucket`, etc.) are **not** exposed — those stay on the Backenly dashboard with explicit confirmation gates.
- Plan-level quota + per-key rate limit enforced server-side.
- All tool calls audit-logged on the project's AuditLog timeline.
- 0600 permissions on the local config file (`~/.backenly/mcp.json`).
- Correlation IDs (`x-correlation-id`) on every request for distributed tracing.

### CLI
- `init` — interactive setup with key verification.
- `health` / `doctor` — verify the configured key.
- `version`, `help`.

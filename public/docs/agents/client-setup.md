# Connecting a client

Index: https://backenly.com/llms.txt

A scoped key comes from **project → Connect → Agents → Generate**. It is bound to one project and revocable.

## MCP

MCP hosts read their server configuration when a session starts, so register Backenly in a terminal **before** you start the conversation.

Claude Code, local (the npm package over stdio):

```
claude mcp add backenly -- npx -y @backenly/mcp-server --project <id> --key <scoped-key>
```

Claude Code, remote (Streamable HTTP, nothing to install):

```
claude mcp add --transport http backenly https://backenly.com/api/mcp --header "x-api-key: <scoped-key>"
```

Remote with a browser sign-in instead of a key: add the URL with no header, run `/mcp`, pick `backenly` and choose Authenticate. You approve the connection on backenly.com and choose the project there; read-only is an option on that screen.

```
claude mcp add --transport http backenly https://backenly.com/api/mcp
```

Codex:

```
codex mcp add backenly -- npx -y @backenly/mcp-server --project <id> --key <scoped-key>
```

Codex remote takes the key only through `~/.codex/config.toml`: a `[mcp_servers.backenly]` table with `url = "https://backenly.com/api/mcp"` and `http_headers = { "x-api-key" = "<scoped-key>" }`.

Cursor and Cline take JSON (`.cursor/mcp.json`, `cline_mcp_settings.json`). The Connect page prints the exact block for each host with the key filled in. Cline's remote entry must set `"type": "streamableHttp"`, or it falls back to SSE and the endpoint answers 405.

The remote endpoint and the stdio package serve the same tools, instructions and results.

## When the tools are not in this conversation

If you registered the server during the current conversation, its tools are not in this conversation's tool list, and retrying will not change that. Do not stop and ask your human to restart: every Backenly tool is callable now from the shell, through the same handlers, with the same key and the same governance.

```
npx -y @backenly/cli@latest link --project <id> --key <scoped-key>
npx -y @backenly/cli@latest tools
npx -y @backenly/cli@latest call read_backend_state
npx -y @backenly/cli@latest call read_backend_state section=schema
npx -y @backenly/cli@latest call apply_migration sql="CREATE TABLE posts (title text NOT NULL)"
npx -y @backenly/cli@latest chat "add a likes counter to posts"
```

`link` stores the key in `.backenly/config.json` and adds `.backenly/` to `.gitignore`. Arguments to `call` are `key=value` pairs; values that are JSON (numbers, objects, `true`) are parsed as JSON. For nested JSON use `--args-file args.json`, or `--args -` to read it from stdin: PowerShell strips the inner quotes from inline JSON, and the CLI refuses a value it can tell was mangled. The exit code is 1 whenever Backenly reports `ok: false`.

The MCP tools are there in the next conversation. `/mcp` lists `backenly` when it worked.

Do not start the MCP server yourself over a stdio bridge, and do not call Backenly's HTTP API with curl to imitate the tools. The CLI is the supported path.

## CLI

`npx -y @backenly/cli@latest <command>`, zero dependencies:

- `link --project <id> --key <key>`: store the key for this repository (gitignored)
- `status`, `schema`: project overview, tables and foreign keys
- `types [--client]`, `openapi`: generated types, typed client, OpenAPI spec
- `diff`: exits 1 when committed types drift from the live schema, for CI
- `logs [--status 5xx] [--follow]`: request logs
- `query "select …"`: read-only SQL
- `tools`, `call <tool> [key=value …]`, `chat "<request>"`: every MCP tool, from the shell
- `install-skill`: write the agent skill into `.claude/skills` and `.cursor/rules`

## The runtime API your app calls

The base is `https://backenly.com/api/v1/{projectId}`.

Two headers, and they are not interchangeable:

- `x-api-key: <project key>` identifies the **project**. Required on every request. Do not send the project key as `Authorization: Bearer`: the data API reads that header as an end-user JWT, and a project key is not one, so the request fails with 401.
- `X-User-Token: <end-user JWT>` identifies the **end-user**; it is what row-level security reads. Without it the request is anonymous and RLS-protected rows come back empty rather than erroring.

Data, two grammars over one engine:

- `/db/{table}`: `GET` (list, with filtering, sorting, pagination and search), `POST` (create), `GET /db/{table}/{id}`, `PATCH /db/{table}/{id}` (`PUT` is accepted as the same update), `DELETE /db/{table}/{id}`.
- `https://backenly.com/api/v2/{projectId}/{table}`: PostgREST's grammar: `?price=gte.100`, `?or=(a.eq.1,b.eq.2)`, `?order=createdAt.desc`, embedded resources such as `?select=*,author(*)`.

REST endpoints are automatic: `/db/<table>` is live the moment a table exists. The end-user auth endpoints are in `auth`; the realtime transport is in `realtime`.

## SDK

```bash
npm install @backenly/sdk
```

```ts
import { createClient } from "@backenly/sdk"
const backend = createClient({ projectId, apiKey })

await backend.auth.signUp({ email, password })
await backend.posts.create({ title: "Hello" })
await backend.posts.list({ filter: { published: true }, search: "launch" })
await backend.storage.upload(file)
backend.posts.subscribe(({ event, row }) => { /* … */ })
```

Query operators include `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `isNull`, `ilike`, `search`, `count`, `sum`, `avg`. A supabase-js compatible entry point is `@backenly/sdk/supabase`. For a plain HTML page with no build step there are bundles at `https://backenly.com/backenly-sdk.js` and `https://backenly.com/backenly-sdk.esm.js`.

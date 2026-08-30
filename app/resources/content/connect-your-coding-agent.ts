import type { ArticleData } from './types'

export const article: ArticleData = {
  slug: 'connect-your-coding-agent',
  title: 'Connect your coding agent',
  metaDescription:
    'Connect Claude Code, Cursor, Codex, or Cline to a Backenly project over MCP. Both transports, scoped and read-only keys, the host restart that everyone hits, and how to verify the connection.',
  lane: 'start',
  category: 'Setup',
  answers: 'How do I point Claude Code, Cursor, or Codex at a Backenly project?',
  datePublished: '2026-08-29',
  dateModified: '2026-08-29',
  dateDisplay: 'Updated August 29, 2026',
  intro:
    'Backenly has one build door: an MCP server your coding agent connects to. There is no in-product chat builder — the agent you already use is the operator, and Backenly is the governed runtime it talks to. Setup is one command, one scoped key, and one restart. The restart is the step people miss, so it gets its own section.',
  sections: [
    {
      heading: 'Get a scoped key',
      blocks: [
        {
          kind: 'p',
          text: 'Keys live in the dashboard under Project → Connect → Agents. They are scoped to a single project and revocable, never a root credential, and every call made with one is rate-limited, quota-tracked, and written to the project\'s change ledger.',
        },
        {
          kind: 'p',
          text: 'Decide read-only or read-write when you mint the key, because an agent cannot change its own and no endpoint flips an existing one. A read-only key is served 6 tools instead of 20 — `read_backend_state`, `get_table_schema`, `run_query`, `generate_types`, `fetch_docs`, and `check_approval`. Every write door is withheld, `backend_chat` included, because the brain can apply non-destructive changes without ever reaching the destructive gate, so a key that could reach it would not be read-only. Calling a mutating tool anyway is refused with `READ_ONLY_KEY` before it runs, and nothing is partially applied.',
        },
      ],
    },
    {
      heading: 'Pick a transport',
      blocks: [
        {
          kind: 'p',
          text: 'Two transports, the same 20 tools behind both. Local runs the npm package over stdio and works in every host. Remote is Streamable-HTTP straight to Backenly, with nothing to install and no Node process on your machine.',
        },
        {
          kind: 'code',
          language: 'bash',
          label: 'Claude Code — local (stdio)',
          code: `claude mcp add backenly -- npx -y @backenly/mcp-server --project <PROJECT_ID> --key <KEY>`,
        },
        {
          kind: 'code',
          language: 'bash',
          label: 'Claude Code — remote (Streamable-HTTP)',
          code: `claude mcp add --transport http backenly https://backenly.com/api/mcp --header "x-api-key: <KEY>"`,
        },
        {
          kind: 'p',
          text: 'For a host that configures MCP through a file rather than a CLI, the Connect → Agents tab renders the exact config for Cursor, Codex, and Cline with your project id and key already filled in. Three host-specific details are worth knowing before you hand-write one:',
        },
        {
          kind: 'list',
          items: [
            'Cursor infers the transport from the presence of a `url` key, so a remote entry needs `url` + `headers` and no `type` field.',
            'Cline remote must set `"type": "streamableHttp"` — camelCase, no hyphen. Omit it and Cline falls back to the legacy SSE transport and gets a 405 from our Streamable-HTTP endpoint. This is the most common Cline setup failure.',
            'The Codex CLI has no header flag, so an `x-api-key` server can only be configured by editing `~/.codex/config.toml`, where headers live under `http_headers`. If it is not picked up, add `[beta] rmcp = true`.',
          ],
        },
        {
          kind: 'p',
          text: 'If you would rather be walked through it, the package has an interactive setup that verifies the key against the live manifest before it writes any config:',
        },
        {
          kind: 'code',
          language: 'bash',
          label: 'Interactive setup',
          code: `npx @backenly/mcp-server init

  ✓ Verified. Connected to project 4f2a…  (20 tools).

  Setup complete. Restart your MCP host and Backenly is wired in.`,
        },
      ],
    },
    {
      heading: 'Restart the host — this is not optional',
      blocks: [
        {
          kind: 'p',
          text: 'MCP hosts connect their servers at process start and read each manifest once. A server registered mid-session is written to config and connected to nothing, so Backenly\'s tools are absent from the session that installed them. No amount of retrying changes that.',
        },
        {
          kind: 'p',
          text: 'This matters more than it sounds, because of what a capable agent does next. Told to install the server and then call a tool, it installs the server, finds no tools, and improvises a way to reach us anyway — a stdio bridge, a raw HTTP call with the MCP key. The permission classifier blocks those, and you watch three failures scroll past in the first minute of using the product. Nothing is broken. The instructions asked for something impossible.',
        },
        {
          kind: 'list',
          items: [
            'VS Code family — Claude Code, Cursor, Cline: Reload Window.',
            'Codex CLI: quit and relaunch.',
            'Claude Desktop: quit and reopen.',
          ],
        },
        {
          kind: 'note',
          text: 'If you are an agent reading this after running the install command: stop here and ask your human to restart the host. Registering first and restarting second is the order that works; restarting before the install accomplishes nothing.',
        },
      ],
    },
    {
      heading: 'Verify it connected',
      blocks: [
        {
          kind: 'p',
          text: 'After the restart, ask for a read. `read_backend_state` is the one read door for project state and it is on the advertised surface, so it is a safe first call:',
        },
        {
          kind: 'code',
          language: 'text',
          label: 'First call',
          code: `Call Backenly's read_backend_state tool and tell me what exists in this project.`,
        },
        {
          kind: 'p',
          text: 'A fresh project answers with almost nothing, and that is correct rather than broken. A new project has a `users` table and no exposed REST resources, because `/db/users` is deliberately never served — that table holds password hashes and is reached only through `/auth/*`. An empty resource list on a project whose only table is `users` is the right answer.',
        },
        {
          kind: 'p',
          text: 'In Claude Code, `/mcp` lists `backenly` once the connection is live. If the tools are still missing after a restart, the usual causes are a key that was revoked, a Cline remote entry without `"type": "streamableHttp"`, or a Codex entry whose header never made it into `config.toml`.',
        },
      ],
    },
    {
      heading: 'What your agent can now do',
      blocks: [
        {
          kind: 'p',
          text: 'The manifest advertises 20 tools. That number is a deliberate cap, not a roadmap gap: tool-selection accuracy degrades as a catalog grows, so the surface is an allowlist where every request has one obvious door. `tools/list` on the server is the authority — trust it over any document, including this one.',
        },
        {
          kind: 'table',
          columns: ['Group', 'Tools'],
          rows: [
            ['Understand', 'read_backend_state · get_table_schema · run_query · fetch_docs'],
            ['Build', 'apply_migration · enable_auth · set_rls · create_bucket · generate_function · enable_realtime'],
            ['Data', 'db_insert · db_update · db_delete'],
            ['Operate', 'branch · create_api_key · set_env_var · get_database_credentials · check_approval · generate_types'],
            ['Natural language', 'backend_chat — the fall-through for anything not named above'],
          ],
          caption: 'The advertised surface. More tools remain dispatchable so clients pinned to an older manifest keep working.',
        },
        {
          kind: 'p',
          text: 'Anything not on that list is reached by describing it to `backend_chat`, which plans and executes through the same governed path. Your agent does not need to learn Backenly\'s vocabulary to be useful — "add likes and comments to my posts table" is a complete instruction.',
        },
        {
          kind: 'p',
          text: 'Agents can also browse live project state as MCP resources — `backenly://state`, `tables`, `apis`, `buckets`, `triggers` — instead of spending a tool call to ask.',
        },
      ],
    },
    {
      heading: 'What your agent cannot do',
      blocks: [
        {
          kind: 'p',
          text: 'Destructive tools are not on the MCP surface at all. `drop_table`, `truncate_table`, `drop_column`, `delete_bucket` and their relatives are dashboard-only, because a host LLM auto-confirming a drop is a failure mode worth designing out rather than warning about.',
        },
        {
          kind: 'steps',
          steps: [
            {
              label: 'Agent',
              title: 'Describes the destructive operation',
              body: 'Through `backend_chat`, since there is no direct tool. The call returns an approval id instead of a result.',
            },
            {
              label: 'Backenly',
              title: 'Parks it in the Review Queue',
              body: 'The dashboard card names the target, the live row count where it can read one, and whether the data is recoverable.',
            },
            {
              label: 'You',
              title: 'Approve or reject in the dashboard',
              body: 'Nothing runs until a human confirms. Approval replays the exact stored call rather than re-deriving it from prose.',
            },
            {
              label: 'Agent',
              title: 'Polls `check_approval`',
              body: 'Terminal statuses distinguish `failed` (nothing applied — safe to retry) from `partial` (some changes landed — verify current state instead of replaying).',
            },
          ],
        },
        {
          kind: 'responsibility',
          platform: [
            'Serves the tool manifest and enforces key scope on every call.',
            'Refuses destructive operations over MCP and routes them to human approval.',
            'Records every governed change with an audit entry.',
            'Verifies the key against the live manifest during `init` before writing config.',
          ],
          you: [
            'Restart the MCP host after installing.',
            'Choose read-only or read-write when you mint the key, and revoke keys you stop using.',
            'Approve or reject anything that reaches the Review Queue.',
            'Keep the key out of your repository — it is a credential, not configuration.',
          ],
        },
      ],
    },
  ],
  conclusion:
    'Mint a scoped key, add the server on either transport, restart the host, and confirm with one `read_backend_state` call. From there your agent reads the live schema instead of guessing at it, and the operations it should never perform unattended are structurally out of reach rather than discouraged in a prompt.',
  relatedSlugs: ['your-first-backend', 'the-data-api'],
}

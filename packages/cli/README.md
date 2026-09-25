# @backenly/cli

The terminal door into your [Backenly](https://backenly.com) backend — built for humans *and* the coding agents they work with (Claude Code, Cursor, Codex).

```bash
# Link this repo to your project (key: dashboard → Connect → Agents → Generate key)
npx @backenly/cli link --project <PROJECT_ID> --key <SCOPED_KEY>

npx @backenly/cli status           # tables, endpoints, functions at a glance
npx @backenly/cli schema           # every table, column, type, FK relationship
npx @backenly/cli types --client   # generate backenly.types.ts + typed client
npx @backenly/cli openapi          # download the OpenAPI 3.0 spec
npx @backenly/cli logs --follow    # tail live request logs
npx @backenly/cli query "select count(*) from posts"   # read-only SQL, workspace-scoped
npx @backenly/cli install-skill    # teach Claude Code / Cursor the Backenly vocabulary
```

## Every MCP tool, from the shell

```bash
npx -y @backenly/cli@latest tools                                   # what this key can call
npx -y @backenly/cli@latest call read_backend_state section=schema  # any tool, key=value args
npx -y @backenly/cli@latest call apply_migration sql="ALTER TABLE posts ADD COLUMN likes integer DEFAULT 0"
npx -y @backenly/cli@latest call db_insert --args-file row.json      # nested JSON from a file (or --args - for stdin)
npx -y @backenly/cli@latest chat "add comments to posts"            # backend_chat in plain English
```

These post to the same handlers the MCP server uses, with the same key and the same governance. They exist for the conversation that just installed the MCP server: hosts read MCP config when a conversation starts, so the MCP tools only appear in the next one, and an agent can keep working here in the meantime. The exit code is `1` whenever Backenly answers `ok: false`.

## The CI gate

```bash
npx @backenly/cli diff
```

Exits `1` when your committed `backenly.types.ts` no longer matches the live schema — catching backend/frontend contract drift in the pull request instead of in production. Add it next to your lint step.

## Notes

- **Zero dependencies, no build step** — fast `npx` cold starts, safe for agent loops.
- **Governed, not raw.** `call` and `chat` reach exactly what MCP reaches: schema changes are translated into governed actions, and destructive operations return an approval id and wait for a human on the project's Autonomy page.
- Keys are scoped and revocable; `link` stores them in `.backenly/config.json` and gitignores the directory. `BACKENLY_API_KEY` / `BACKENLY_API_URL` env vars are also honored.
- Agent docs: https://backenly.com/llms.txt · installable skill: https://backenly.com/skill.md

MIT © Backenly

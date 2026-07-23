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

## The CI gate

```bash
npx @backenly/cli diff
```

Exits `1` when your committed `backenly.types.ts` no longer matches the live schema — catching backend/frontend contract drift in the pull request instead of in production. Add it next to your lint step.

## Notes

- **Zero dependencies, no build step** — fast `npx` cold starts, safe for agent loops.
- **Read-only by design.** Backend *changes* go through governed doors: the Backenly dashboard, or MCP `backend_chat` (destructive operations always wait for human approval in the Review Queue).
- Keys are scoped and revocable; `link` stores them in `.backenly/config.json` and gitignores the directory. `BACKENLY_API_KEY` / `BACKENLY_API_URL` env vars are also honored.
- Agent docs: https://backenly.com/llms.txt · installable skill: https://backenly.com/skill.md

MIT © Backenly

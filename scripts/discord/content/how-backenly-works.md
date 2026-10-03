# How Backenly works

Most backend platforms hand you primitives and leave you owning schema design, API wiring, RLS policies, monitoring, and recovery. Newer agent-native backends hand an agent raw SQL and no safety net.

Backenly does neither. The distinction that matters: it does not just *generate* backend resources, it *manages backend change safely*.

## The four pieces

**1. The MCP door.** You describe the product you're building through the coding agent you already use — Claude Code, Cursor, Codex. The MCP server advertises **20 tools**, deliberately capped, because tool-selection accuracy degrades as the catalog grows. Your agent can also read live project state as MCP resources (`backenly://state`, `tables`, `apis`, `buckets`, `triggers`) instead of spending a tool call to ask.

**2. The Brain.** An intent-first planner derives entities, relations, and actions from natural language. No table designer, no hand-written migrations.

**3. The governed kernel.** Every mutation — from an agent, from the dashboard, or from an automated repair — goes through one typed action kernel with dry-run, audit, and rollback. There is deliberately **no raw-SQL path for mutating structure**, so the agent's model of the database and the database itself cannot silently diverge. Reads are ordinary SQL.

<!-- split -->

**4. The autonomy loop.** A closed MAPE-K loop watches the running backend after the change lands and repairs drift, missing indexes, broken triggers, and RLS gaps on its own. It heals only the reversible safe band. Anything risky — auth, external credentials, destructive or irreversible changes — waits for a human.

## What that gets you

| Capability | What you get |
|---|---|
| **Database** | PostgreSQL, a schema per project, served through PostgREST |
| **Auth & Users** | Email/password and social sign-in, JWT sessions, RLS-forced user tables |
| **Storage** | Public and private buckets with per-file access control |
| **Realtime** | Shared `LISTEN`/`NOTIFY` hub for table change subscriptions |
| **Functions** | Serverless route modules, validated before they ship and self-healed if they break |
| **Integrations** | One `ctx.integrations.<id>.request()` surface for third-party APIs |
| **Monitoring** | Request logs with stability and reliability scoring |
| **Branches** | Preview branches with their own sequences, plus diff and merge |

<!-- split -->

## Two properties worth knowing up front

**Isolation is enforced by Postgres, not by application code.** Each project gets its own schema (`workspace_{projectId}`), and the boundary is held by grants and row-level security — never by string filtering in the app. The application role is `NOSUPERUSER NOBYPASSRLS` on purpose: a superuser bypasses RLS, including `FORCE ROW LEVEL SECURITY`, so an app running as one has its own policies applied only by convention.

**Your data is not locked in.** Direct PostgreSQL connection strings and full `pg_dump` exports are one command away. The query grammar is PostgREST's, which you already know.

## Read more

- **[Resources](https://backenly.com/resources)** — connecting your agent, the data API, and the rest
- **[README](https://github.com/backenly/backenly#readme)** — architecture and the full self-host walkthrough
- **[llms.txt](https://backenly.com/llms.txt)** — point your agent at this to teach it the platform

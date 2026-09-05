<div align="center">

<img src="public/backenly-icon-hd.svg" alt="Backenly" width="112" height="112" />

# Backenly

### Your coding agent builds it. Backenly keeps it running.

The autonomous backend platform for agentic coding. PostgreSQL, REST APIs, auth,
storage, realtime, and functions, driven by your coding agent over MCP, with every
change planned, verified, and reversible.

<br/>

[![License](https://img.shields.io/badge/platform-Apache--2.0-3b82f6?style=flat-square)](LICENSE)
[![Clients](https://img.shields.io/badge/SDK%20%C2%B7%20CLI%20%C2%B7%20MCP-MIT-22c55e?style=flat-square)](packages/)
[![npm downloads](https://img.shields.io/npm/dm/@backenly/mcp-server?style=flat-square&label=mcp%20server&color=f59e0b)](https://www.npmjs.com/package/@backenly/mcp-server)
[![Contributors](https://img.shields.io/github/contributors/backenly/backenly?style=flat-square&color=64748b)](https://github.com/backenly/backenly/graphs/contributors)
[![GitHub stars](https://img.shields.io/github/stars/backenly/backenly?style=flat-square&label=stars&color=8b5cf6)](https://github.com/backenly/backenly/stargazers)

[![Follow on X](https://img.shields.io/badge/Follow-%40Backenly-0f0f0f?style=for-the-badge&logo=x&logoColor=white)](https://x.com/Backenly)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-Backenly-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/company/117034579)
[![Star on GitHub](https://img.shields.io/badge/Star-on%20GitHub-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/backenly/backenly)

**[backenly.com](https://backenly.com)** &nbsp;·&nbsp; [Resources](https://backenly.com/resources) &nbsp;·&nbsp; [Pricing](https://backenly.com/pricing) &nbsp;·&nbsp; [Client libraries](https://github.com/backenly/backenly-js)

https://github.com/user-attachments/assets/2b215d72-4b1b-4a4c-8290-a94553be192d

</div>

> ⭐ **Star the repo** to follow releases and help other builders find Backenly.

---

## What this is

Most backend platforms hand you primitives and leave you owning schema design,
API wiring, RLS policies, monitoring, and recovery. Newer agent-native backends
hand an agent raw SQL and no safety net.

Backenly does neither. You describe the product you're building through the
coding agent you already use (Claude Code, Cursor, Codex) over an MCP server.
Backenly derives the data model, generates the endpoints, writes the policies,
applies the change, and then **verifies it against the live runtime**. A
continuous autonomy loop keeps watching after that, repairing drift, missing
indexes, broken triggers, and RLS gaps on its own.

The distinction that matters: Backenly does not just *generate* backend
resources, it *manages backend change safely*. Every mutation, whether it comes
from an agent, from the dashboard, or from an automated repair, goes through one
typed action kernel with dry-run, audit, and rollback. There is deliberately no
raw-SQL path for mutating structure. Reads are standard SQL, and your data is
never locked in: direct Postgres connection strings and full `pg_dump` exports
are one command away.

## How it works

<div align="center">
  <img src=".github/assets/architecture.svg" width="100%" alt="Your coding agent drives Backenly over MCP. The Brain plans the change, executeAction governs and verifies it, and it lands in PostgreSQL. A closed MAPE-K autonomy loop watches the running backend and repairs it back through the Brain." />
</div>

- **Intent-first.** An LLM planner derives entities, relations, and actions from
  natural language. No table designer, no hand-written migrations.
- **One governed kernel.** Every mutation flows through `executeAction`, so the
  agent's model of the database and the database itself cannot silently diverge.
- **Closed-loop autonomy.** The loop heals the reversible safe band by itself.
  Anything risky, such as auth, external credentials, or destructive and
  irreversible changes, always waits for a human.
- **Multi-tenant by construction.** Each project gets its own PostgreSQL schema
  (`workspace_{projectId}`). Isolation is enforced by Postgres grants and RLS,
  never by application-level string filtering.
- **PostgREST data plane.** Tables are served through PostgREST, so the query
  grammar you already know works unchanged.

## Core capabilities

| Capability | What you get |
|---|---|
| **Database** | PostgreSQL with a schema per project, served through PostgREST |
| **Auth & Users** | Email/password and social sign-in, JWT sessions, RLS-forced user tables |
| **Storage** | Public and private buckets with per-file access control |
| **Realtime** | Shared `LISTEN`/`NOTIFY` hub for table change subscriptions |
| **Functions** | Serverless route modules, validated before they ship and self-healed if they break |
| **Integrations** | One `ctx.integrations.<id>.request()` surface for third-party APIs |
| **Autonomy** | MAPE-K loop that observes, detects, proposes, applies, and verifies repairs |
| **Monitoring** | Request logs with stability and reliability scoring |
| **Branches** | Preview branches with their own sequences, plus diff and merge |
| **Deploy** | Governed rollout with restore points and an audit ledger |

## What your agent can actually do

The MCP server advertises **20 tools**. The catalog is capped deliberately, because
tool-selection accuracy degrades as it grows, while the dispatcher stays wider so an
agent pinned to an older manifest never gets a 404.

| Group | Tools |
|---|---|
| **Understand** | `read_backend_state` · `get_table_schema` · `run_query` · `fetch_docs` |
| **Build** | `apply_migration` · `enable_auth` · `set_rls` · `create_bucket` · `generate_function` · `enable_realtime` |
| **Data** | `db_insert` · `db_update` · `db_delete` |
| **Operate** | `branch` · `create_api_key` · `set_env_var` · `get_database_credentials` · `check_approval` · `generate_types` |
| **Natural language** | `backend_chat`, the fall-through for anything not named above |

Agents can also browse live project state as MCP **resources** (`backenly://state`,
`tables`, `apis`, `buckets`, `triggers`) instead of spending a tool call to ask.

## Quick start

### Cloud

Create a project at **[backenly.com](https://backenly.com)**, then point your agent
at it. Nothing to install or operate.

### Self-hosted

One deployment is one project. `npm run bootstrap` provisions that project, and
it is a reconciler rather than an installer: rerunning it repairs whatever is
missing and changes nothing else. You will run it at least twice, and that is
the intended path, not a failure.

**You install on the host:**

- **Node.js 20+** — the app, the scripts and the CLI all run here, not in a
  container
- **Docker**, with Compose

**The Compose stack provides:**

- **PostgreSQL 15**, with `pg_stat_statements` preloaded
- **Redis**
- **PostgREST**, pinned — this is the `/db/*` data plane

Docker does not provide Node. If you would rather run your own PostgreSQL or
PostgREST, read [Bringing your own database](#bringing-your-own-database) first;
the steps below describe the Compose path.

> **Use a PostgreSQL cluster dedicated to this deployment.**
>
> PostgREST authenticates through cluster-global roles, and the list of schemas
> it serves is stored as a role setting with no `IN DATABASE` scope. Two
> Backenly databases on one cluster therefore overwrite each other's
> served-schema registry, and the loser's data plane answers `PGRST106` on every
> table. This is a known limitation being redesigned, not something you can
> configure around. The Compose stack gives you a dedicated one.

#### 1. Install

```bash
git clone https://github.com/backenly/backenly.git
cd backenly
npm install
cp .env.example .env

docker compose -f docker-compose.dev.yml up -d
```

`postgrest` will restart in a loop until step 4 issues its password. That is
expected, and it is deliberate that it serves nothing until then.

Then set these in `.env`, adding any line the template does not already carry —
today that is `BACKENLY_EDITION` and `BACKENLY_PROJECT_ID`:

```bash
BACKENLY_EDITION=single-tenant   # the default is still `cloud`; it flips in a later release
BACKENLY_PROJECT_ID=<uuid>       # any UUID, e.g. `uuidgen`
JWT_SECRET=<openssl rand -hex 32>
POSTGREST_JWT_SECRET=<openssl rand -hex 32>
STORAGE_SECRET=<openssl rand -hex 32>
OPENAI_API_KEY=<your key>
```

`DATABASE_URL` already matches the Compose stack, so leave it alone unless you
changed `POSTGRES_USER` or `POSTGRES_PASSWORD`.

`BACKENLY_PROJECT_ID` is the identity of this deployment and must never change
afterwards: it names the `workspace_<uuid>` schema your tables live in. Bootstrap
refuses to run against a database that already holds a different one. You may
leave it unset and pin the id bootstrap generates instead, but then step 4's
command has to be copied from bootstrap's output rather than from here.

`JWT_SECRET` signs every platform session. `POSTGREST_JWT_SECRET` is separate and
must match the value Compose passes to PostgREST, because the gateway mints
short-lived internal tokens with it. `STORAGE_SECRET` signs the access tokens for
stored files — without it every upload fails with a 500 whose only explanation is
in the server log. None of the three has a default, deliberately: a fallback
baked into a public repository is a key everybody already knows.
`OPENAI_API_KEY` powers planning and the autonomy loop. See
[`.env.example`](.env.example) for the rest.

#### 2. Tell the database which role Backenly connects as

**Skip this on the Compose path.** The stack already uses `backenly_user`, which
is what the SQL defaults to.

It applies only if you brought your own database and the role in your
`DATABASE_URL` is something else, in which case run, as a superuser:

```bash
psql -c "ALTER DATABASE <db> SET backenly.app_role = '<your role>'"
```

Skipping it there makes the next section fail with
`role "backenly_user" does not exist`.

#### 3. Create the tables and bootstrap

```bash
npm run db:generate && npm run db:push
npm run bootstrap
```

**This first run is expected to exit 3.** Bootstrap creates the project row, its
workspace schema and its signing secret, then reports what it cannot install
itself. Its exit code is the state, and deployment automation should read it:

| exit | meaning |
| --- | --- |
| `0` | ready |
| `2` | refused. The database is in a state bootstrap will not touch, either more than one project or a `BACKENLY_PROJECT_ID` that does not match what is already there. Nothing was written. |
| `3` | core bootstrapped, prerequisites still unmet. **Not** ready: the `/db/*` data plane will answer `PGRST106` until step 4 is done. |

#### 4. Install the prerequisites bootstrap cannot install itself

These reach the database as a superuser. Bootstrap prints this same list, with
your real project id filled in; run what it prints.

```bash
# 1. support objects: registry functions, DDL event triggers, and the
#    anon / authenticated / service_role / backenly_authenticator roles.
bash scripts/postgrest-install.sh

# 2. passwords, role membership and the per-schema grants.
#    Prints the connection string PostgREST authenticates with. Store it: it is
#    not recoverable, and this command will not print it again.
npx tsx scripts/setup-postgrest-roles.ts --project <PROJECT_ID> --apply

# 3. put that password in .env as POSTGREST_AUTHENTICATOR_PASSWORD, then start
#    the data plane. It has been restarting in a loop until now.
docker compose -f docker-compose.dev.yml up -d postgrest

# 4. optional. Only needed to hand out direct psql credentials to a project.
#    Backenly is fully operational without it.
bash scripts/install-sql.sh scripts/setup-direct-access.sql
```

Those scripts talk to PostgreSQL through one explicit mechanism, chosen by
`BACKENLY_DB_ADMIN`, so the same command works wherever the database lives:

| `BACKENLY_DB_ADMIN` | how it connects |
| --- | --- |
| `docker` (default) | `psql` inside the Compose `postgres` service |
| `url` | `psql "$BACKENLY_ADMIN_DATABASE_URL"` — any reachable database |
| `local` | `sudo -u postgres psql` — a cluster installed on this host |

That order is not arbitrary and cannot be collapsed into one command. The first
has to create the roles, because the event triggers it installs grant to them,
and a `CREATE SCHEMA` that grants to a role nobody created aborts. The second
grants per workspace schema, so it needs the schema `npm run bootstrap` already
created above. This is why bootstrap runs, reports NOT ready, and is rerun: it is
a reconciler, and rerunning is the mechanism.

Then rerun:

```bash
npm run bootstrap
```

**Exit 0 means ready.** Anything else, read what it printed and fix that; it is
safe to rerun as many times as you need.

#### 5. Run it

```bash
npm run dev                   # dashboard :3000 · runtime :3001
```

`npm run dev` starts both processes together. There is no account yet, so sign up
in the dashboard, then run `npm run bootstrap` once more to issue the anon key
your frontend embeds.

#### Autonomy

The self-healing loop runs by itself. There is nothing to schedule.

`instrumentation.ts` starts an in-process scheduler when the app boots, and it
is active whenever `VERCEL` is unset — which is every self-hosted deployment. The
reconciler ticks **every minute**. `.env.example` already sets the two flags it
needs, so a `.env` copied from it has autonomy on:

```bash
ENABLE_AUTONOMY_RECONCILER=true      # the loop runs at all
ENABLE_AUTONOMY_LIVE_EXECUTION=true  # it may apply fixes, not just observe
```

Confirm it is ticking by watching the process output:

```
[AutonomyReconciler] Cron run complete — 1 projects, 0 fixes applied, 0 frozen
```

**`0 projects` is normal on a new install, and does not mean it is broken.** A
project is only reconciled once it has at least one table (or an open finding)
*and* recent activity. A backend with no tables has nothing to be right or wrong
about, so the loop skips it. Create a table through your agent and the count
becomes 1 on the next tick.

`CRON_SECRET` is **not** required for any of the above. It guards one ad-hoc
endpoint, for forcing a tick without waiting for the minute:

```bash
CRON_SECRET=<openssl rand -hex 32>   # add to .env, then restart
curl -H "x-cron-secret: $CRON_SECRET" http://127.0.0.1:3000/api/cron/autonomy
```

Nothing calls that URL on its own. The in-process scheduler is the mechanism;
the endpoint is for operators.

#### Bringing your own database

The Compose stack is the supported path. If you already operate PostgreSQL, or
run PostgREST under your own service manager, the differences are:

- Point `DATABASE_URL` and `DIRECT_URL` at your database, and do step 2 above.
- Run the step 4 scripts with `BACKENLY_DB_ADMIN=url` and
  `BACKENLY_ADMIN_DATABASE_URL` set to a superuser connection string, or with
  `BACKENLY_DB_ADMIN=local` if PostgreSQL is on this machine.
- Start your own PostgREST against the connection string step 4.2 prints, with
  `POSTGREST_URL` in `.env` pointing at it and its JWT secret set to
  `POSTGREST_JWT_SECRET`. Use the version pinned in
  [`docker-compose.dev.yml`](docker-compose.dev.yml): PostgREST reads its
  configuration out of the database, so a version difference changes what the
  data plane serves.
- Enable `pg_stat_statements` yourself:

```conf
# postgresql.conf, then restart the server
shared_preload_libraries = 'pg_stat_statements'
```
```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

It is how Backenly finds indexes that are missing by *measurement* — the columns
Postgres is actually spending milliseconds filtering on — rather than only by
schema shape. Without it that check reports itself as unchecked rather than
passing, so nothing claims a guarantee it never evaluated. The Compose stack sets
it already.

## Connecting a coding agent

Backenly is built to be driven over MCP. Point your agent at the MCP server:

```bash
npx @backenly/mcp-server init
```

Works with Claude Code, Cursor, Codex, Cline, and Claude Desktop. Keys are scoped
and revocable, and read-only keys serve a reduced tool set.

> **Restart your MCP host after installing.** Tools stay absent until it
> reconnects, which looks like a broken install but is not one.

Verify the connection by asking your agent:

```
Call Backenly's read_backend_state tool and tell me what exists in this project.
```

Then describe what you want. The SDK is for the app you ship:

```js
const backend = new BackenlyClient({ projectId, apiKey })
await backend.auth.signUp({ email, password })
await backend.posts.create({ title: 'Hello' })
await backend.posts.list({ filter: { published: true } })
```

## Repository layout

| Path | What lives there |
|------|------------------|
| `app/` | Next.js routes: dashboard UI, platform APIs, and the public `/api/v1/*` runtime |
| `lib/ai/` | The Brain: planning, the tool loop, and `executeAction`, the governed mutation kernel |
| `lib/orchestration/` | The nine-phase pipeline from intent to verified change |
| `lib/autonomy/` | The MAPE-K loop that monitors and repairs running backends |
| `lib/execution/` | Schema writes, migrations, and rollback beneath the kernel |
| `lib/tenant/` | Schema isolation and the tenant boundary |
| `packages/` | Client libraries: SDK, CLI, MCP server (MIT) |
| `prisma/` | Platform schema: the `public` schema, not tenant data |
| `server/` | Express runtime serving the end-user API |
| `scripts/` | Operational tooling, probes, and the demo recording pipeline |

[`AGENTS.md`](AGENTS.md) is the deeper architectural guide, and is written for
coding agents working in this repo as much as for people.

## Self-hosting vs Cloud

Self-hosting is free and complete. This repository is the whole platform:
runtime, governance, and the full self-healing engine, not a stripped community
edition. You bring the servers, the Postgres, and the OpenAI key.

[Backenly Cloud](https://backenly.com/pricing) runs the same codebase, and
handles infrastructure, backups, upgrades, and the autonomy tokens. `pg_dump`
moves your data between the two in either direction.

## Contributing

**Pull requests are open and welcome.** Bug reports, feature requests, questions,
and code all help. Good first places to look are open issues, the probe and
detector suite under `lib/autonomy/`, and client library ergonomics in
`packages/`. If a change is large or moves an architectural boundary, open an
issue first so we can agree the approach before you spend the time.

Before opening a PR:

```bash
npm run lint
npx tsc --noEmit
npm test
npx tsx scripts/preflight-oss.ts --tree    # no credentials in what you committed
```

Two things worth knowing before you write code here. Tests run against a real
PostgreSQL instance, and the database is never mocked, because mocking it has
caused production incidents here before. And every schema mutation goes through
`executeAction`; a patch that writes DDL around the kernel will be sent back, no
matter how correct the SQL is.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

## Security

Please do not open a public issue for a security problem. See
[SECURITY.md](SECURITY.md) for the private reporting route.

## License

The platform is licensed under the [Apache License 2.0](LICENSE).

The client libraries under [`packages/`](packages/), the SDK, CLI, and MCP
server, are MIT, so they impose nothing on the applications that embed them.

## Trademark

Apache-2.0 §6 grants no rights to the Backenly name or logo, and this project
does not grant them separately. You may fork, modify, self-host, and
commercialise the software. Distributing it under the Backenly name requires
written permission.

Describing your project as "built on Backenly" or "a fork of Backenly" is
accurate and always welcome. See [TRADEMARK.md](TRADEMARK.md) for the full
policy, including what you may do without asking.

---

<div align="center">

**[Star Backenly on GitHub](https://github.com/backenly/backenly)** to get notified about new releases.

</div>

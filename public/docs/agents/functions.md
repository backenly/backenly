# Functions

Index: https://backenly.com/llms.txt

Server-side code, fired by an end-user signing up (`on_signup`), a row event (`on_insert`, `on_update`, `on_delete` on a table), an HTTP request (`http`), a schedule, or by hand (`manual`). There are two ways to make one:

- `functions { action: "create" }`: Backenly writes the code from your plain-English spec with its own model, which draws AI credits. Name the tables it touches and the integrations it calls.
- `functions { action: "deploy_code" }`: you write the code; it is stored exactly as written, with no model reading or rewriting it, after the runtime that will run it checks that it can.

## Actions

<!-- generated:actions:functions by scripts/generate-agent-docs.ts from lib/mcp/domains.ts; do not edit -->
Call as `functions { action: "<action>", … }`.

| Action | What it does | Needs | Read-only key | Approval |
| --- | --- | --- | --- | --- |
| `create` | a function from a plain-English spec, fired by sign-up, a table event, HTTP or manually | `name`, `description`, `trigger` | no | no |
| `deploy_code` | your own source: a route module for trigger http, a ctx sandbox body for every other trigger; replaces the code of a function with the same name | `name`, `code`, `trigger` | no | no |
| `list` | every function with its trigger and on/off state | nothing | yes | no |
| `get` | one function in full: its code, trigger, endpoint, state and last error | nothing | yes | no |
| `invoke` | run it once now and get its answer, return value and log lines; a failure is reported, never auto-repaired | nothing | no | no |
| `logs` | recent runs from every trigger, with errors and ctx.log lines | nothing | yes | no |
| `set_active` | turn a function on or off | `active` | no | no |
| `delete` | remove a function | nothing | no | waits for a human |
| `schedule` | a job on a schedule ("every 15 minutes" or 5-field cron) | `description`, `schedule` | no | no |
| `list_schedules` | every scheduled job | nothing | yes | no |
| `delete_schedule` | remove a scheduled job | nothing | no | waits for a human |
<!-- end generated -->

## The two runtime contracts

Which one a function uses is set by its trigger.

**`trigger: "http"`: a route module**, served at `https://backenly.com/api/v1/{projectId}/fn/{name}`:

```ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function POST(request: Request) {
  const { title } = await request.json()
  const rows = await prisma.$queryRawUnsafe('SELECT id FROM posts WHERE title = $1', title)
  return NextResponse.json({ rows })
}
```

It may import only `next/server`, `@/lib/db` (a `prisma` whose raw SQL runs in this project's schema), `@/lib/auth/jwt` (`verifyToken`, for this project's end-user tokens), `crypto`, `bcryptjs` and `jsonwebtoken`. Its SQL logs in as the project's own database role: it reads and writes this project's tables, row-level security applies to the caller the request carries, and PostgreSQL refuses anything outside the project (Backenly's own tables, other projects). `process.env` holds only `JWT_SECRET` (this project's end-user signing secret), `ADMIN_API_KEY` (this project's admin key) and `NODE_ENV`; none of Backenly's own configuration. Export one handler per HTTP method; when a module exports several, pass `method`.

**Every other trigger: a sandbox body**, the inside of an async function that receives `event` and `ctx` and may return a value:

```js
const rows = await ctx.db.query('orders', { status: 'paid' })
ctx.log('paid orders', rows.length)
await ctx.integrations.email.send({ to: event.data.email, subject: 'Thanks', html: '<p>Paid.</p>' })
return { count: rows.length }
```

- `ctx.db.query(table, where?)`, `ctx.db.insert(table, row)`, `ctx.db.update(table, where, patch)`, `ctx.db.delete(table, where)`: this project's tables only; update and delete need a non-empty `where`.
- `ctx.http.get(url, headers?)`, `ctx.http.post(url, body, headers?)`: outbound requests through the egress guard, which refuses private and metadata addresses.
- `ctx.log(...)`: lines recorded with the run.
- `ctx.integrations.<provider>`: connected providers, with their keys kept server side (`integrations`, and each provider's topic).
- `ctx.env.KEY`: variables set with `connect { action: "set_env" }`.
- `ctx.require(name)`: only `pdfkit`, `csv-parse/sync`, `date-fns`, `qrcode`, `nodemailer` and `archiver`.

It runs in an isolated worker with no `process`, no `require`, no dynamic `import`, no `eval`, and a 10-second limit.

## deploy_code

`functions { action: "deploy_code", name, trigger, code }`, plus `table` for a row trigger and `method` for http. Before anything is stored it checks that:

- `code` is the contract its trigger takes, and the runtime accepts it (compiles, uses only what that runtime provides);
- it is at most 64 KB;
- it holds no credential written into it (a Stripe, OpenAI, Anthropic, Resend, SendGrid or GitHub key, a private key, a database URL with a password). Put keys in `integrations` and values in `ctx.env`;
- a row trigger's `table` exists in this project.

The name is lowercased to kebab-case, because it is a URL path segment, and the receipt says when it changed. Deploying a name that exists replaces that function's code: there is no version history, so there is nothing to roll back to, and the receipt carries `codeSha256` and `previousCodeSha256`. A function someone switched off stays off. The receipt never echoes the code.

## Running and reading runs

`invoke` runs a function once as the owner's test run and returns what its handler answered, its return value and its log lines. A failure is reported with its error and the code is left exactly as it was: nothing repairs it behind your back. A function that is switched off is refused, not switched on. Each run counts as one invocation against the plan. `logs` returns recent runs from every trigger, successes and failures, with their error and `ctx.log` lines, kept 30 days.

## Schedules

`schedule { description, schedule }` takes "every 15 minutes" or a five-field cron expression.

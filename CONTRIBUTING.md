# Contributing to Backenly

Backenly is an autonomous backend platform: it plans backend changes, applies
them, verifies the result, and keeps every change reviewable and reversible.
That last property is the product. Most of the conventions below exist to
protect it.

> **Pull requests are open.** Bug reports, feature requests, questions, and code
> are all welcome. If a change is large or reshapes an architectural boundary,
> open an issue first so we can agree the approach before you spend the time.

## Licensing

The platform is **Apache-2.0**. Client libraries under `packages/` (the SDK,
CLI, and MCP server) are **MIT**, because they get embedded in your users'
applications and should carry the lightest possible obligation.

Apache-2.0 is permissive: you may use, modify, and redistribute this, including
commercially and in closed-source products. It adds two things MIT does not: an
explicit patent grant from contributors, and a requirement to state what you
changed. That is what makes it straightforward for companies to adopt.

By contributing you agree your contribution is licensed under the same terms as
the code it touches, per Apache-2.0 section 5.

## Getting a local instance running

You need Docker and Node 20+. You do **not** need access to any Backenly server.
If a change only works against production, that is a bug in the change.

```bash
cp .env.example .env          # fill in OPENAI_API_KEY; the rest have defaults
docker compose -f docker-compose.dev.yml up -d   # PostgreSQL + Redis
npm install
npm run db:push               # create the schema
npm run dev                   # Next.js + the Express runtime, together
```

Then `npm test`. Tests use a **real database**. See below.

## The rules that are not negotiable

These are not style preferences. Each one is here because violating it has
previously caused a production incident.

### Never mock the database

Tests run against real PostgreSQL. Mocks agree with whatever you believed when
you wrote them, which means a test suite full of mocks passes precisely when
your mental model is wrong, the exact case a test exists to catch. Several
outages in this codebase were shipped green.

### Platform users and end users are different systems

| | Platform users | End users |
|---|---|---|
| Who | developers using Backenly | users of an app built *on* Backenly |
| Auth | `lib/auth/` + `JWT_SECRET` | `project.jwtSecret` |
| Data | `public` schema (Prisma) | `workspace_{projectId}` schema |

Never let one authenticate as the other. Cross-project token replay is prevented
by per-project signing secrets, and any change that centralises those removes
the protection.

### Only the Database/AI section creates new backend reality

Monitoring, auth settings, and billing manage things that already exist. Adding
a "quick create" button elsewhere breaks the model that makes changes reviewable,
because a change made outside the governed pipeline has no plan and no rollback.

### A probe that cannot run must not report "healthy"

Detectors return findings; they do not swallow errors into an empty result. An
empty array means "I looked and found nothing", and a failed query returning `[]`
is a claim of health for a system nobody examined. Throw instead: the caller
records the probe as unavailable, which is true.

### Auto-fixes may not widen a security boundary

Autonomy applies repairs unattended. Anything that grants access, loosens an
RLS predicate, or exposes a table must be surfaced for a human instead. The test
for this is not "would this help" but "what happens if the diagnosis was wrong":
a wrong additive fix wastes a cycle, a wrong permissive fix is a breach.

## Before you open a pull request

Run all four. The last one is not optional: this repository is public.

```bash
npm run lint
npx tsc --noEmit
npm test
npx tsx scripts/preflight-oss.ts --tree    # no credentials in what you committed
```

The preflight gate scans **committed** content. A secret you removed from your
working tree but already committed is still published when the branch is pushed,
and rewriting the commit later does not recall the copies.

## Commit messages

Explain **why**, not what. The diff already says what. If a change prevents a
specific failure, name the failure. A future reader deciding whether they can
safely remove your code needs to know what it was protecting against.

## Reporting a vulnerability

Do not open a public issue. See [SECURITY.md](SECURITY.md).

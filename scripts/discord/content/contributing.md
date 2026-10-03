# Contributing

**Pull requests are open.** Bug reports, feature requests, questions, and code are all welcome. If a change is large or reshapes an architectural boundary, open an issue first so we can agree the approach before you spend the time.

Full guide: **[CONTRIBUTING.md](https://github.com/backenly/backenly/blob/main/CONTRIBUTING.md)**

## Licensing

The platform is **Apache-2.0**. Client libraries under `packages/` — the SDK, CLI, and MCP server — are **MIT**, because they get embedded in your users' applications and should carry the lightest possible obligation.

Apache-2.0 is permissive: use, modify, and redistribute, including commercially and in closed-source products. It adds two things MIT doesn't — an explicit patent grant from contributors, and a requirement to state what you changed. That's what makes it straightforward for companies to adopt.

<!-- split -->

## A local instance

```bash
cp .env.example .env    # fill in OPENAI_API_KEY; the rest have defaults
docker compose -f docker-compose.dev.yml up -d
npm install
npm run db:push
npm run dev
```

Then `npm test`. **Tests use a real database.** You do not need access to any Backenly server — if a change only works against production, that's a bug in the change.

## The one convention that isn't negotiable

Every change is reviewable and reversible. That property *is* the product, and most of the conventions in CONTRIBUTING.md exist to protect it. Structural mutation goes through the typed action kernel — dry-run, audit, rollback — never through raw SQL. A PR that adds a second path around it won't land, however much less code it is.

## Getting the Contributor role

Ping a @Core Team member with your merged PR and we'll add it.

-# Security issues are never a PR or a public issue. Email support@backenly.com with SECURITY in the subject.

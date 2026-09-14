# Managed database migration — findings and acceptance gate

Status: **investigation banked, implementation deferred.** No code here.

## Why this document exists

Phase 6b of the autonomous self-maintenance roadmap needed one new table. Adding
it required a migration, and establishing whether a migration could safely be
applied uncovered a platform-level gap that has nothing to do with self-
maintenance.

This records what was measured, so none of it has to be rediscovered, and fixes
the acceptance gate in advance so the follow-up work cannot become open-ended
archaeology.

Every claim below was measured against the real staging environment from a
one-shot Fargate task, not inferred. Nothing was written to the staging
database; the only mutations were inside throwaway schemas that were dropped.

---

## 1. Staging is db-push-managed, not migration-managed

Measured on `backenly-staging-pg`, database `backenly`:

```
_prisma_migrations          does not exist   (to_regclass → null)
public base tables          120
projects / health_findings / background_jobs   all present
migration rows              0
```

The schema is fully built and there is **no migration ledger at all**. The
documented deploy path runs `npm run db:push`, which synchronises schema without
recording history — so the 25 entries under `prisma/migrations/` have never been
applied here.

**Consequence:** pointing `prisma migrate deploy` at this database would see
every migration as unapplied while its schema effects already exist. Best case it
fails on the first `CREATE TABLE`; worse, it partially applies and leaves a
divergent ledger.

## 2. `prisma/migrations/` contains 18 migrations and 6 loose files

```
18  directories containing migration.sql   ← the Prisma chain
 6  loose .sql files                       ← invisible to Prisma
      add_api_versioning.sql
      add_mcp_read_only_keys.sql
      add_oidc_delegation.sql
      add_rls_policies.sql
      add_signup_trust.sql
      uncap_autonomy_healing.sql
```

Prisma only reads directories containing `migration.sql`. **Nothing in the
repository applies the six loose files** — no script, no workflow, no deploy
step references any of them. They were applied by hand.

So the live schema is the product of `db push` **plus** six manual patches, and
replaying the 18-migration chain into an empty database cannot reproduce the six
unless their effects also reached `schema.prisma`.

## 3. No image can run migrations

Probed the staging **web** image directly:

```
prisma/schema.prisma        present
prisma/migrations/          0 entries
node_modules/.bin/prisma    absent
node_modules/prisma         absent
```

The runtime image is narrower still — `dist-runtime`, `@prisma/client`,
`.prisma`, `schema.prisma`.

The cause is structural rather than an oversight: **`prisma` is a
devDependency**, and the web image ships Next's standalone *traced*
`node_modules`, which contains only what application code imports. The CLI is
never imported, so it is never traced in.

## 4. The startup migration guard cannot work here

`lib/db/startup-validation.ts` shells out to `npx prisma migrate status`. With no
CLI in the image that throws, and the catch branch falls back to checking a few
tables and a column — which can report a valid startup while migration history is
absent or stale.

It is worse than "the CLI is missing": even *with* a CLI, `migrate status` against
a ledger-less database would report all migrations pending.

**Direction:** the runtime should not shell out to a CLI it deliberately does not
ship. It should read the migration ledger through Prisma Client and compare it to
an expected migration identifier baked into the build. Migration *application*
belongs to a deployment job, not to a long-running application container.

## 5. Database role capabilities

```
current_user / session_user   backenly_admin
rolsuper        false     RDS has no true superuser
rolcreatedb     true      scratch databases are available without privilege changes
rolcreaterole   true
rolbypassrls    false
```

`rolbypassrls: false` is a Phase 6b constraint in its own right — the admin role
cannot bypass RLS either, which is precisely why a dual-write trigger needs
`SECURITY DEFINER` rather than relying on the connecting role.

## 6. Prisma cannot faithfully replay a migration script

```
ERROR 42601: cannot insert multiple commands into a prepared statement
```

Prisma's raw API uses the extended protocol, so `$executeRawUnsafe` cannot submit
a whole `migration.sql`. Splitting on semicolons is not an acceptable workaround:
several migrations contain dollar-quoted PL/pgSQL with semicolons inside function
bodies.

**`pg` with `queryMode: 'simple'` can**, and it was proven on staging:

```
multi_statement_script        ACCEPTED
dollar_quoted_function_runs   true
created                       1 table, 2 functions, 1 trigger
```

**`pg` does not need to be in the image.** Bundled with esbuild, minified and
gzipped, it is 33.9 KB inside a task definition — well under the 64 KB limit —
and the existing ephemeral Fargate harness carries it unchanged. **Docker and ECR
are therefore unnecessary for lineage analysis.**

## 7. TLS needs explicit handling, and the shortcut must not be inherited

`pg` is stricter than Prisma: RDS presents an AWS-issued chain and Node answers
`SELF_SIGNED_CERT_IN_CHAIN`. Additionally, **`sslmode` in the connection string
overrides the `ssl` option** in pg 8.x, so it must be stripped before explicit
SSL config takes effect.

The smoke test used `rejectUnauthorized: false` because it was read-only,
ephemeral, and connecting to a private endpoint from inside the same VPC. **The
lineage probe must not inherit that** — it creates databases and replays DDL, so
it should embed the AWS RDS CA bundle and verify properly.

## 8. Open question: RLS policy visibility

The smoke test read `pg_policies` and saw **zero rows** for the whole cluster.
That is either genuinely zero policies in `public`, or a visibility/context
limitation of this role.

It must be attributed before any comparison is trusted, because
`add_rls_policies.sql` is one of the six loose files, and "no policies" is
exactly what a broken read looks like.

## 9. What the RDS rehearsal already proved

Separately established at 7/7 against staging (see
`scripts/rehearse-maintenance-rds.ts`): metadata-only `ADD COLUMN`,
**`SECURITY DEFINER` triggers work on RDS**, trigger exceptions can be swallowed
without aborting caller writes, resumable idempotent batched backfill,
reconciliation catches silent divergence, expand rollback leaves catalog and
source unchanged, and `lock_timeout` is settable.

That result carries one invariant for any future work here:

> **Prisma pools connections, so a session-scoped `SET` is not observable by a
> later query.** Lock waits must be bounded transaction-locally with `SET LOCAL`
> inside `$transaction`. A bare `SET` followed by separate statements is a safety
> control that does nothing while reading as though it does.

---

## The acceptance gate

Fixed in advance, so the follow-up cannot drift into indefinite investigation.

The comparison is **three-way**, not scratch-versus-staging:

```
A = scratch built by replaying the 18 migration.sql files
B = A plus the six loose patches, in a historically derived order
C = staging, untouched and read-only

A ↔ C   everything the Prisma chain cannot explain
B ↔ C   residual divergence after known hand patches
A ↔ B   the exact footprint of the loose files
```

Every difference is classified:

```
represented_in_schema_prisma     arrived via db push; chain simply lacks it
known_loose_sql_effect           attributable to one of the six files
unexplained_divergence           neither
```

Comparison must be semantic, not counts: tables, columns (type, nullability,
default, identity/generated), primary keys, foreign keys, unique and check
constraints, indexes, enums and user-defined types, RLS enabled/forced state,
`pg_policies`, triggers and trigger functions, and views. Normalise whitespace
and OIDs; **do not** normalise away `SECURITY DEFINER`, trigger timing and
events, policy commands and roles, or function bodies.

Ordering of the six loose files is derived from git history and dependency
analysis. Where an order cannot be established, the file is reported
`replay: NOT_PROVEN` with its DDL targets attributed — **never** by trying
permutations until one succeeds.

Do **not** create `_prisma_migrations` in the scratch databases. This gate
answers a schema-lineage question; ledger semantics belong to a later
`migrate resolve` rehearsal.

### The decision

```
18 migrations replay successfully
        ↓
known hand-patch effects attributed
        ↓
chain + known patches compared with staging
        ↓
unexplained semantic divergence == 0
        ↓
ONLY THEN design the migrate-resolve baseline
```

- **residual unexplained divergence == 0** → history is incomplete but the
  database state is explainable; baselining is tractable.
- **residual unexplained divergence > 0** → stop. The push history and the
  migration chain describe different worlds, and the result is a deliberate
  reconciliation project, not "keep trying until it looks close."
- **any part of the chain cannot be replayed faithfully** → inconclusive, no
  baseline.

### After a passing gate

Build a dedicated migration image or job — **not** Prisma CLI plus 25 migration
directories added to the web or runtime images. Deployment tooling stays out of
long-running application containers. The runner should refuse by default without
an explicit target (`scratch`), require a separate mode for a staging baseline,
and require an entirely different confirmation path for production.

Do not remove `db push` from the existing deploy path until staging has
completed that whole transition.

---

## What this does NOT block

Phase 6a reconciliation (the read-only safety oracle) and the RDS rehearsal
harness are complete and independently valuable. Neither becomes less useful
because Phase 6b waits for schema delivery.

Phase 6b's persistence ledger stays blocked. It should not be worked around by
storing maintenance steps inside `BackgroundJob` or `AuditLog`: those are job
lifecycle and audit storage, and using them to dodge a schema-delivery problem
would turn a deployment gap into a data-model one.

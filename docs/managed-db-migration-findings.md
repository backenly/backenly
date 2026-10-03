# Managed database migration — findings and acceptance gate

Status: **investigation active** on `infra/managed-db-migration-baseline`. The
section *Repo inspection corrections* (2026-09-15) records where the first
version of this document was wrong; the sections after it are corrected in place.

## Why this document exists

Phase 6b of the autonomous self-maintenance roadmap needed one new table. Adding
it required a migration, and establishing whether a migration could safely be
applied uncovered a platform-level gap that has nothing to do with self-
maintenance.

This records what was measured, so none of it has to be rediscovered, and fixes
the acceptance gate in advance so the follow-up work cannot become open-ended
archaeology.

Every claim about staging below was measured against the real staging
environment from a one-shot Fargate task, not inferred. Nothing was written to
the staging database; the only mutations were inside throwaway schemas that were
dropped.

---

## Enum ownership and failed-migration recovery (2026-09-24)

The first migration to `ALTER` an enum, `20260924120000_project_pause`, failed
on staging at its first statement:

```
ALTER TYPE "WebhookDeliveryStatus" ADD VALUE 'CANCELLED'
ERROR: must be owner of type "WebhookDeliveryStatus"   (42501)
```

- **Cause.** The app-role cutover (`tools/managed-db/sql/app-role-cutover.sql`,
  run on both environments around 2026-09-20) moved public relations and
  functions to `backenly_app`. It did not move types. The runner connects as
  `backenly_app`, which owned 127 of the 128 public tables; all five enums
  were still owned by `backenly_admin`. Measured read-only on staging.
  Production ran the same SQL.
- **Blast radius.** Nothing was applied: Postgres rolled back the implicit
  transaction, and the columns, index and enum value were verified absent.
  But Prisma wrote a FAILED row to `_prisma_migrations`, and a failed row
  refuses every later deploy (P3009). The runner could not resolve it.
- **OSS self-host is unaffected.** `setup-app-role` runs before the schema
  exists, so the app role creates and owns every enum there.

The fix, in four parts:

1. **The cutover moves enums too.** It discovers them from the catalog,
   excludes extension members, and asserts none are left. Check mode shows
   current owner -> desired owner.
2. **`scripts/run-enum-ownership-repair.ts`** handles databases already cut
   over.
   - Its only dynamic statement is `ALTER TYPE … OWNER TO`, audited before the
     SQL is sent. It never touches a role, password, secret, grant, table or
     row. Re-running the cutover instead would rotate the application
     credential.
   - It has check mode first, needs `--confirm-apply`, and is idempotent.
   - It refuses an enum owned by a third role.
   - It is guarded on the account, the RDS instance endpoint and master
     secret, and the database, which is checked again inside the SQL.
3. **The runner can resolve a failed migration:** `rollback <id>`.
   - It needs `MIGRATE_ROLLBACK_CONFIRM` naming the same migration.
   - It is allowed only for a migration with an absence proof
     (`tools/managed-db/runner/checks/<id>.absent.sql`), and resolves only
     when that proof passes. Prisma itself refuses to roll back a migration
     that is not in a failed state.
4. **The runner runs an ownership preflight before every `deploy`**
   (`checks/ownership-preflight.sql`). The migration role must be able to
   alter every migration-managed object in `public`, or nothing starts and no
   history is written.

**Trap, measured with Prisma 5.22:** after `migrate resolve --rolled-back`,
`migrate status` prints "Database schema is up to date!" and exits 0, although
the migration is unapplied and the next `deploy` applies it. After a rollback,
`status` is not evidence of anything. The evidence is `verify <id>` failing,
then the deploy's own `Applying migration` line, then `verify <id>` passing.

The whole sequence, the incident included, is rebuilt against a real
PostgreSQL in `tests/integration/migration-ownership-recovery.spec.ts`. An
admin that is not a superuser builds the chain, the tables move, and the enums
stay behind.

---

## Repo inspection corrections (2026-09-15)

An inspection of the repository before building the lineage probe contradicted
several statements the first version of this document made. This section keeps
the evidence, so the earlier claims are not rediscovered as facts.

### 1. `prisma/migrations/` is not part of the repository

`.gitignore` excludes `/prisma/migrations`. None of the 18 migration directories
or 6 loose files exist on `main` or in the private overlay repository; they exist
only in a local working tree. Public history begins at the OSS import on
2026-07-23, so no file in that corpus has reachable git history, and ordering the
loose files "from git history" is impossible.

The corpus is preserved as forensic evidence under
`tools/migration-lineage/evidence/`, with a SHA-256 for every file. It is not
Backenly's migration history and must never be executed as deployment history.
`/prisma/migrations` stays ignored.

### 2. The migration chain describes less than half of the schema

Replayed intact, one file per simple-protocol query, into an empty PostgreSQL 16.4:

```
legacy chain, 18 migrations in Prisma order   18/18 replayed, 50 tables
schema.prisma projection                      119 tables
tables only in the schema.prisma projection   69
shared tables whose columns differ            11
```

The projection is `prisma migrate diff --from-empty --to-schema-datamodel
prisma/schema.prisma --script`, which needs no database. `add_auth_security` has
no timestamp and sorts last in Prisma's order.

The chain is historical evidence, not a candidate baseline. A future baseline
would most likely be generated from the current schema rather than by marking
these 18 migrations applied.

### 3. Four of the six loose files cannot apply to the chain

Each file applied on its own to a clone of the replayed chain:

```
add_mcp_read_only_keys.sql   applies
add_signup_trust.sql         applies
add_api_versioning.sql       42704  MySQL-style inline INDEX; invalid PostgreSQL
add_oidc_delegation.sql      42601  MySQL-style inline INDEX; invalid PostgreSQL
add_rls_policies.sql         42P01  relation "Table" does not exist
uncap_autonomy_healing.sql   42703  column exists only after db push
```

The two invalid files can never have run on any PostgreSQL as written; the chain
creates their tables with valid syntax. `add_rls_policies.sql` addresses Prisma
*model* names, but every model it names except `Deployment` is mapped to a
snake_case table, and `ExecutionHistory` is not a model at all.

A file sent as one simple query is one implicit transaction, so each failure
above had no effect. A historical `psql` run without `ON_ERROR_STOP` continues
past errors, so partial effects are possible. A replay result therefore cannot
stand in for a file's footprint.

### 4. Staging was not built from migrations plus hand patches

The recorded provisioning path for the AWS candidate takes a fresh database
through:

```
db:generate → db:push → bootstrap → postgrest-install.sh
  → setup-postgrest-roles.ts → setup-direct-access.sql → bootstrap
```

The six loose files are not proven to have been applied to staging.

### 5. Production provisioning lineage is unknown

Nothing inspected records whether production RDS was restored from the Hetzner
dump, built by `db push`, or produced some other way. Do not infer it from staging
or from historical Hetzner behaviour.

### 6. The loose files are not the only non-Prisma SQL

Repository-owned code creates database structure outside Prisma:

```
scripts/sql/postgrest-schema-registry.sql    functions, a table, a policy, event triggers
scripts/sql/postgrest-ddl-sync.sql           functions, an event trigger
scripts/setup-direct-access.sql              functions, policies, event triggers
scripts/setup-postgrest-roles.ts             roles, grants, default privileges
scripts/bootstrap.ts                         schemas
scripts/apply-webhook-domain-migration.sql   tables, indexes, a function, triggers
scripts/apply-billing-migration.sql          tables
scripts/add-billing-minimal.sql              tables
scripts/create-integration-keys-table.cjs    a table
scripts/enable-rls.ts → lib/db/rls.ts        RLS and policies
```

Treating every non-Prisma object as unexplained would fail any gate for the wrong
reason. The installers also create and alter cluster-wide roles, so they cannot be
replayed into a scratch database on a shared instance without changing the
instance itself.

### 7. One task definition cannot carry the whole probe

Gzipped: `pg` client 24.2 KB, legacy chain 8.4 KB, schema projection 14.3 KB,
loose files 4.0 KB, installers 18.9 KB, RDS CA bundle 2.9 KB. Base64-encoded
together they exceed the 64 KB task-definition limit, so the probe runs one task
per database state. (The 33.9 KB figure in section 6 included the smoke probe.)

---

## The result (2026-09-16)

The probe ran against staging as four one-shot Fargate tasks. All four passed,
staging was only read, and every scratch database was created and dropped with
none left behind.

**Verdict: `STAGING_BASELINE_ELIGIBLE`.** Scoped to staging, which is the only
environment measured.

```
P -> C   objects missing from staging            0
         objects defined differently in staging  0
         objects staging holds beyond the model  33   all attributed
         unexplained_divergence                  0
```

The 33 are provisioning, attributed by definition rather than by name:

```
scripts/sql/postgrest-schema-registry.sql   22   schemas postgrest and backenly_pgrst_idle,
                                                 the registry table with its columns, primary key
                                                 and index, 2 event triggers, 16 routines
scripts/setup-direct-access.sql              8   2 event triggers, 6 routines
scripts/sql/postgrest-ddl-sync.sql           3   1 event trigger, 2 routines
```

Those expectations were derived by replaying each file, in the order
`scripts/postgrest-install.sh` applies them, into a throwaway PostgreSQL cluster
on top of the schema.prisma projection, and capturing what appeared or changed
(`tools/migration-lineage/derive-manifests.ts`). Every routine matched by body
digest, so staging's provisioning objects are byte-identical to the repository's
current SQL.

**Section 8 is settled: staging genuinely has zero policies.** `pg_policy` read
directly, the same rows joined through `pg_class` and `pg_namespace`, and the
`pg_policies` view all agree at zero, while a policy created in a scratch
database was seen by the same reads. RLS is enabled on 0 of 120 `public` tables,
and no `workspace_*` schema holds a table. Nothing `add_rls_policies.sql`
describes is present.

**No staging object needed a legacy-SQL attribution** (`known_legacy_sql_effect`
= 0). Everything the six loose files would have contributed is either already in
`schema.prisma`, and therefore in P, or absent entirely as with the RLS policies.

TLS verified against the embedded ap-south-1 roots (TLSv1.3, leaf ← *Amazon RDS
ap-south-1 Subordinate CA RSA2048 G1.A.5* ← *Root CA RSA2048 G1*), and both
negative controls were refused by verification: public roots without the RDS CA
gave `SELF_SIGNED_CERT_IN_CHAIN`, and the correct CA against a wrong identity
gave `ERR_TLS_CERT_ALTNAME_INVALID`.

For the record, A → P, which does not gate anything: the chain builds 50 of the
119 tables, and carries 4 columns and 1 index the current model no longer has
(`plans.allowFullExport`, `plans.removeBranding`, `backend_patterns.failure_count`,
`backend_patterns.success_count`, `workspaces_projectId_idx`) plus one changed
default (`plans.allowedAuthProviders`).

### What this does and does not authorise

It authorises **designing and rehearsing** a staging baseline. It is not
authority to baseline staging. Production is covered separately below.

---

## Production (2026-09-16)

Correction 5 said production's lineage was unknown. It is now established,
read-only, and it is **not** what staging's story would have predicted.

### Provenance

`/ecs/backenly-production/db-bootstrap`, stream `cutover/cutover/c37b33c7…`:

```
pg_restore of the Hetzner dump (sha256 de8d1122…) into an EMPTY backenly
  + globals, role attributes, memberships, settings
  + credential verifiers, transferred verbatim
  + V3 PostgREST provisioning (schema-registry, ddl-sync), registry seeded = 17
  + setup-direct-access (bkn_ro_* roles)
DATABASE CUTOVER COMPLETE
```

Production therefore carries Hetzner's accumulated history. Earlier `restore/…`
streams in that group ran against `backenly_migration_rehearsal` with the final
database untouched, so only the `cutover` stream speaks for the live database.
The group has 30-day retention: anything older is unknown, not absent.

### The comparison

```
P -> C_prod   objects missing from production            0
              objects defined differently in production  0
              provisioning extras                       33   attributed
              platform extensions                        3   attributed
              unexplained_divergence                     0
```

**Verdict: `PRODUCTION_LINEAGE_EXPLAINED`.**

The three extensions (`pg_stat_statements`, `pgstattuple`, `vector`) are
classified `known_provisioning_effect`, subtype `platform_extension`, in
`tools/migration-lineage/manifests/provisioning-platform-extensions.json`. They
are repo-owned and intentionally outside `schema.prisma`, which declares no
extensions, so the projection can never contain them. They are **not**
`expected_environmental_difference`: that bucket is too weak for objects the
product depends on. `pg_stat_statements` feeds measured slow-query detection and
its absence is reported UNCHECKED rather than healthy; `vector` backs the shipped
`enable_vector_search` capability. Extension *version* is recorded but excluded
from the equality gate: a version bump is a provisioning fact, not divergence.

**The stronger fact:** production and staging's captured platform schemas are
semantically identical — 120 tables, 1332 columns, 230 constraints, 531 indexes,
21 routines, 5 event triggers, 0 public policies — despite completely different
provenance (dump restore versus `db push`). Production additionally holds 22
`workspace_*` tenant schemas, 99 tenant tables and all 421 policies (87 RLS, 80
FORCE), none of which are platform schema.

### Managed environment capability parity: FAIL

Reported separately, and it must stay separate. An explained lineage does not
mean the environments are equivalent.

```
production   pg_stat_statements  pgstattuple  vector
staging      none of them
```

Staging cannot run the detectors that depend on `pg_stat_statements`, so a clean
autonomy run there can mean "never checked". `tools/production-lineage/report.ts`
exits 4 for this case: lineage explained, parity not proven.

Closing that gap is **not** merely `CREATE EXTENSION`. `pg_stat_statements`
requires `shared_preload_libraries` and a restart, which on RDS is parameter-group
and reboot semantics. Before any baseline mutation, check staging's RDS parameter
configuration read-only.

### The decomposition this produces

A managed database is five layers, and trying to force them all into Prisma
migrations is what made this project necessary:

```
1  server/platform prerequisites     shared_preload_libraries, parameter groups
2  database extensions               pg_stat_statements, pgstattuple, vector
3  canonical application schema      a squashed baseline from schema.prisma
4  non-Prisma managed provisioning   PostgREST registry, DDL sync, direct access
5  tenant/runtime state              workspace_* schemas, policies, tenant data
```

**The safety rule that falls out of it:** the baseline owns layer 3 and nothing
else. It must never reconcile, drop or otherwise reach production's 22
`workspace_*` schemas and 99 tenant tables. A baseline generated from
`schema.prisma` also contains no extensions, so layer 2 must be owned explicitly
by provisioning or a rebuilt database comes up missing capabilities two detectors
need.

That rule is executable rather than remembered: `tools/managed-db/layers.ts`
classifies any captured object into a layer and refuses baseline SQL that reaches
`CREATE EXTENSION`, roles, grants, event triggers, default privileges,
provisioning objects or a `workspace_*` schema. A rehearsal fails on its own
instead of relying on a reviewer noticing.

---

## Managed capability discovery (2026-09-16)

Read-only, both environments, nothing installed.

**Layer 1 is already satisfied on staging, and there is no restart boundary.**
Both instances run user-managed parameter groups with
`shared_preload_libraries = pg_stat_statements`, `in-sync`, nothing pending
reboot. The staging server confirms it itself rather than by inference:

```
SHOW shared_preload_libraries   rdsutils,pg_stat_statements,rds_casts
source                          configuration file
context                         postmaster
pending_restart                 false
```

Per-extension status on staging (`tools/migration-lineage/probe/capabilities.ts`):

```
pg_stat_statements   available_not_installed   available 1.10   preloaded yes
pgstattuple          available_not_installed   available 1.5    no preload needed
vector               available_not_installed   available 0.8.1  no preload needed
```

All three are available at exactly the versions production runs. So the parity
failure is **layer 2 only**: ordinary database provisioning, no parameter-group
change and no reboot.

The status model distinguishes four things that "extension missing" would
flatten, because they have different owners:

```
preload_missing             instance configuration: parameter group and restart
available_not_installed     database provisioning: CREATE EXTENSION
installed_not_operational   installed but broken; investigate, do not reinstall
unavailable                 the package is not on this server at all
operational                 installed and proven to work by a real read
```

`preload_missing` outranks `available_not_installed` deliberately: with no
preload, `CREATE EXTENSION` would simply fail. "Installed" is not "operational"
either, so each extension carries a harmless read that proves it works
(`tools/managed-db/extension-spec.ts`).

Nothing was installed. The evidence is banked first so the baseline project does
not quietly become a provisioning-mutation project.

---

## Production is migration-managed (2026-09-16)

Both environments now have migration history, delivered by the same runner image
and verified the same way. Production was baselined only after the mechanism was
proven end to end on staging, which is the order the gate below requires.

**Before.** A fresh read-only capture reconciled completely against the
pre-ledger projection: 0 missing, 0 defined differently, 36 provisioning extras
all attributed, **0 unexplained**, capability parity PASS (`pg_stat_statements`
1.10, `pgstattuple` 1.5, `vector` 0.8.1 in both). The eleven
`provisioning/prisma-migration-ledger` manifest entries were reported as *not
observed*, which was correct: production had no `_prisma_migrations` yet.

**Baselining.** `migrate resolve --applied 00000000000000_baseline`. A
`migrate deploy` first would have tried to APPLY the baseline against a database
that already holds all 120 tables, which is the whole reason resolve exists.

| | before | after baseline | after ledger |
|---|---|---|---|
| tables | 120 | 121 | 123 |
| columns | 1332 | 1340 | 1370 |
| constraints | 230 | 231 | 234 |
| indexes | 531 | 532 | 541 |

Measured as diffs rather than read off the counts:

- baselining changed **11 objects, all `_prisma_migrations`**; canonical delta
  **0**.
- the ledger migration changed **44 objects, all `maintenance_executions` and
  `maintenance_step_executions`** (2 tables, 30 columns, 3 constraints, 9
  indexes), every one `extra_in_right`; **nothing else moved**.
- second `migrate deploy` a no-op, `migrate status` clean, all three production
  services ACTIVE 1/1.
- the full report then returns **PRODUCTION_LINEAGE_EXPLAINED, 0 unexplained, 0
  manifest entries unobserved**.

Production and staging now hold identical platform schemas — 123 tables / 1370
columns / 234 constraints / 541 indexes / 21 routines / 5 event triggers / 0
public policies — having arrived there from opposite provenance (pg_restore of
the Hetzner dump vs `db push`).

**A third guard, at the connection.** `scripts/run-production-migration-job.ts`
is its own launcher rather than a `--target production` flag on the staging one,
for the reason the read-only capture gives: the staging surface also carries
arbitrary bundled payloads for the lineage replays. It checks the AWS account and
checks that the secret's ARN names a production resource — but both are checks on
POINTERS, and both pass whether or not the secret's contents point where the ARN
suggests. So `EXPECT_DATABASE` is passed into the container, where the runner
parses the URL it actually connected with and refuses if the database is not that
one. It matters for `baseline`, which writes history into whatever it reaches and
is not undone by re-running it somewhere else.

---

## Staging is migration-managed (2026-09-16)

Finding 1 below is now historical. Staging has migration history, applied by the
dedicated Layer 3 runner rather than by the application image.

**What ran.** `00000000000000_baseline` was resolved as applied against the real
staging database, then `20260916120000_maintenance_ledger` — the first
post-baseline migration, carrying the Phase 6b execution ledger — was deployed
through `scripts/run-migration-job-fargate.ts` as a one-shot Fargate task on
image `backenly-runtime:migrate-02bec30d`:

```
status  exit 1  1 migration pending: 20260916120000_maintenance_ledger
deploy  exit 0  Applying migration `20260916120000_maintenance_ledger`
deploy  exit 0  No pending migrations to apply.
status  exit 0  Database schema is up to date!
```

The runner image contains the canonical chain and the pinned Prisma CLI, and
nothing else; the gitignored legacy corpus cannot enter it, because the build
context is assembled from `prisma/migrations-canonical/`.

**Post-baseline capture.** A fresh read-only capture of staging, compared
against a replay of the current `schema.prisma` in a scratch database:

| | P (schema.prisma) | C (staging) |
|---|---|---|
| tables | 121 | 123 |
| columns | 1360 | 1370 |
| constraints | 232 | 234 |
| indexes | 539 | 541 |

The whole difference reconciles: `_prisma_migrations` (8 columns, 1 constraint,
1 index) plus the one provisioning table already manifested. Attribution:

```
represented_in_schema_prisma       2259
known_provisioning_effect            47
unexplained_divergence                0
```

**The ledger needed a manifest.** `_prisma_migrations` is created by
`prisma migrate`, never by `schema.prisma`, so without an entry it would read as
eleven unexplained objects on every capture for the rest of this database's
life — the kind of standing noise that trains a gate to be ignored. It is
`known_provisioning_effect`, subtype `migration_ledger`, in
`tools/migration-lineage/manifests/provisioning-prisma-migration-ledger.json`.

The manifest claims its field values were replayed, and that claim is now
checked rather than asserted: `tools/managed-db/rehearse-baseline.ts` creates the
ledger in a throwaway database and fails if the objects it created are not
exactly the ones the manifest names. A Prisma CLI upgrade that changed the
ledger's shape surfaces there instead of being absorbed.

**Two reporting defects found while doing this.** Both made a report say
something that was not observed, which is the failure mode this document exists
to prevent:

- A run that did not replay the legacy chain was reported as *"a replayed file
  did not match its recorded hash"*. Since staging is baselined the chain is
  forensic evidence, not a lineage input, so omitting it is normal. `ok: null`
  now means "nothing to verify" and is distinct from a hash mismatch, which
  still blocks.
- Non-gating notes were dropped whenever the verdict was eligible, so a verdict
  reached with a leg missing printed identically to one reached with every leg
  run. `GateResult.notes` now carries them and the report prints them.

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
recording history, and the migration corpus was never delivered to this database.

**Consequence:** pointing `prisma migrate deploy` at this database would see
every migration as unapplied while its schema effects already exist. Best case it
fails on the first `CREATE TABLE`; worse, it partially applies and leaves a
divergent ledger.

## 2. The local migration corpus: 18 migrations and 6 loose files, untracked

```
18  directories containing migration.sql   ← the legacy Prisma chain
 6  loose .sql files                       ← invisible to Prisma
      add_api_versioning.sql
      add_mcp_read_only_keys.sql
      add_oidc_delegation.sql
      add_rls_policies.sql
      add_signup_trust.sql
      uncap_autonomy_healing.sql
```

Prisma only reads directories containing `migration.sql`. **Nothing in the
repository applies the six loose files**, no script, no workflow, no deploy step
references any of them. Where they were applied, it was by hand.

The whole corpus is gitignored (correction 1). The chain builds 50 of 119 tables
(correction 2), four loose files cannot apply to it (correction 3), and staging
was provisioned by `db push` and installers rather than by either (correction 4).

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
never imported, so it is never traced in. The migration directories were never
in the repository to begin with (correction 1).

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
gzipped, the smoke probe was 33.9 KB inside a task definition, and the existing
ephemeral Fargate harness carries it unchanged. **Docker and ECR are therefore
unnecessary for lineage analysis.** A single task cannot carry every SQL input as
well, so the lineage probe uses one task per database state (correction 7).

## 7. TLS needs explicit handling, and the shortcut must not be inherited

`pg` is stricter than Prisma: RDS presents an AWS-issued chain and Node answers
`SELF_SIGNED_CERT_IN_CHAIN`. Additionally, **`sslmode` in the connection string
overrides the `ssl` option** in pg 8.x, so it must be stripped before explicit
SSL config takes effect.

The smoke test used `rejectUnauthorized: false` because it was read-only,
ephemeral, and connecting to a private endpoint from inside the same VPC. **The
lineage probe must not inherit that** — it creates databases and replays DDL, so
it should embed the AWS RDS CA bundle and verify properly. A wrong-CA connection
must be shown to fail, or the verification proves nothing.

## 8. RLS policy visibility — settled 2026-09-16, see "The result" above

The smoke test read `pg_policies` and saw **zero rows**. `pg_policies` covers only
the database the session is connected to, so that observation covers one
database, not the cluster. It is either genuinely zero policies, or a query,
filter or visibility problem.

It must be attributed before any comparison is trusted, because "no policies" is
exactly what a broken read looks like.

**Do not assume privilege visibility is the explanation.** That is the
comfortable answer and it is unfalsifiable from a single empty result. Settle it
by joining `pg_policy` to `pg_class` and `pg_namespace` directly rather than
reading the `pg_policies` view, by inspecting `relrowsecurity` and
`relforcerowsecurity` on the tables themselves, and by a positive control: a
policy created in a scratch database must be seen by the same query.

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

## The acceptance gate (revised 2026-09-15)

The original three-way model (chain / chain plus the six patches / staging) is
withdrawn. Correction 3 makes "chain plus patches" a database that never existed,
and correction 4 means staging was never built from either.

The question is now: **can the current Prisma model plus explicitly documented
non-Prisma effects fully explain staging?**

```
A  legacy 18-migration chain, replayed into a scratch database   historical evidence
P  current schema.prisma projection, in a scratch database        the canonical model
C  staging, read-only                                             the reference
M  reviewed manifests of non-Prisma effects                       legacy SQL, provisioning
```

```
A ↔ P   how far the historical chain fell behind the current model    reported, not gating
P ↔ C   what staging holds beyond or below schema.prisma              gating
M       explains the P ↔ C differences Prisma cannot represent
```

Every difference is classified:

```
represented_in_schema_prisma        present in P
known_legacy_sql_effect             matches a legacy loose-file manifest entry
known_provisioning_effect           matches a named provisioning source
expected_environmental_difference   narrow: genuine engine or host facts only
unexplained_divergence              none of the above
```

**Attribution matches semantics, not names.** A staging object is attributed to a
manifest entry only when its definition matches the entry's intended effect:
type, nullability, default, index columns and predicate, trigger timing and
events, policy command, roles and expressions, `SECURITY DEFINER`, and so on.

Each legacy loose-file manifest records `source_file`, `replay_status`
(`valid_postgres`, `invalid_postgres`, `depends_on_db_push`,
`partial_historical_effect_possible`, `unknown`), `intended_effects`,
`observed_matching_effects_on_staging`, `confidence` and `notes`.

Cluster-wide state (roles, memberships, role-level settings) is reported in a
separate provisioning inventory, not folded into schema equivalence.

Comparison must be semantic, not counts: tables, columns (type, nullability,
default, identity/generated), primary keys, foreign keys, unique and check
constraints, indexes, enums and user-defined types, RLS enabled/forced state,
policies, triggers and trigger functions, routines, views and extensions.
Normalise whitespace and OIDs; **do not** normalise away `SECURITY DEFINER`,
trigger timing and events, policy commands and roles, or function bodies.

Where a loose file's history cannot be established, it is reported as such with
its intended effects attributed. **Never** try orderings or permutations until
something runs.

Do **not** create `_prisma_migrations` in any database. This gate answers a
schema-lineage question; ledger semantics belong to a later `migrate resolve`
rehearsal.

### The decision

```
STAGING_BASELINE_ELIGIBLE only if
  objects in P missing from C, or defined differently in C   = 0
  AND every semantic C-only object is known_legacy_sql_effect,
      known_provisioning_effect or expected_environmental_difference
  AND unexplained_divergence                                 = 0
  AND every capture and replay the verdict depends on is conclusive
```

- **Any count above is nonzero** → `RECONCILIATION_REQUIRED`. Stop and report the
  residual differences. This is a deliberate reconciliation project, not "keep
  trying until it looks close."
- **Any capture or replay is not conclusive** → `INCONCLUSIVE`. No baseline.

**The verdict is scoped to staging, never global.** `STAGING_BASELINE_ELIGIBLE`
authorizes designing and rehearsing a staging baseline and nothing more. Before
production goes anywhere near `migrate resolve`, it needs its own read-only
capture (`C_production`) and established provisioning provenance. If production
descends from a Hetzner restore, the legacy loose files may matter there even
though they did not on staging.

### After a passing staging gate

Build a dedicated migration image or job, **not** the Prisma CLI plus a migration
corpus added to the web or runtime images. Deployment tooling stays out of
long-running application containers. The baseline itself would most likely be
generated from the current `schema.prisma` rather than taken from the legacy
chain. The runner should refuse by default without an explicit target
(`scratch`), require a separate mode for a staging baseline, and require an
entirely different confirmation path for production.

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

# Database

Index: https://backenly.com/llms.txt

Every table lives in the project's own PostgreSQL schema. Structure changes only through governed tools, so every change is planned, verified, snapshotted and reversible; reads are first-class.

## Read first

- `read_backend_state { section: "schema" }` (or `tables`, `rls`, `triggers`): what exists.
- `get_table_schema { tableName }`: one table in full: columns (type, nullability, default, primary key), foreign keys with `ON DELETE`, indexes including `UNIQUE`, CHECK constraints with their permitted values, triggers, and live RLS policies with their roles. Read it before any write.
- `run_query { sql }`: read-only SQL: joins, `GROUP BY`, aggregates, window functions, CTEs, `EXPLAIN`. It runs as a SELECT-only role scoped to the project, one statement per call; tables are already in scope (`SELECT * FROM posts`). The PostgreSQL system catalogs are refused; use the two tools above for schema. Results are capped (default 200 rows, at most 1000) and secret-bearing columns come back redacted.

## Change structure

`apply_migration { sql }` takes `CREATE TABLE`, `ALTER TABLE` (`ADD COLUMN`, `RENAME COLUMN`, `ADD CONSTRAINT`, `ALTER COLUMN SET`/`DROP NOT NULL`, `SET`/`DROP DEFAULT`) and `CREATE [UNIQUE] INDEX`. Each statement becomes a governed action and the migration is all or nothing. Anything it cannot map is refused with the tool to use instead. Dropping a table or column, or truncating one, goes through `backend_chat` and waits for a human's approval.

**Columns you did not declare.** Every table created through Backenly gets `id` (uuid primary key), `"createdAt"` and `"updatedAt"` (camelCase, timestamptz) and `"deleted_at"` (snake_case, soft delete). Order by `createdAt`, filter soft deletes on `deleted_at`, and quote camelCase identifiers in SQL: unquoted they fold to lowercase and do not resolve. A declared `id`, `created_at` or `updated_at` in a `CREATE TABLE` is skipped in favour of these, and the receipt says so. Any other column exists exactly as written. `get_table_schema` is the authority.

## Write rows

`db_insert { table, row }`, `db_update { table, filter, patch }`, `db_delete { table, filter }` act as the project owner: they bypass end-user RLS, triggers and function side effects, so they are for seeding and repair, not for simulating an end-user. Filters are column-to-value maps with the operators `$gt`, `$gte`, `$lt`, `$lte`, `$ne`, `$in`, `$contains`, `$ilike`. `db_update` and `db_delete` refuse an empty filter; there is no table-wide update or delete. An unknown argument is refused with the arguments the tool accepts, and one that asks for set-based work (`select`, `groupBy`, `join`, …) is sent to `run_query`.

## Row-level security

`set_rls` takes the policy as **exact SQL**, one rule per command. Predicates are installed verbatim and read back from `pg_policies` before it reports success. It is idempotent, and commands you do not name are left as they were. Predicates may reach a parent row through `EXISTS (SELECT 1 FROM parent p WHERE p.id = child.parent_id AND …)`; the end-user is `backenly_jwt_claim('sub')`.

Use `set_rls` whenever you can write the predicate. Describing a policy to a model means it is re-derived rather than applied, and a re-derived predicate can come back more permissive. When you cannot write it, the named templates are reached through `add_rls` via `backend_chat` ("lock messages down so only the conversation's participants can read them"): `auto`, `owner_read_write`, `participants` (two or more user columns), `owned_via_parent`, `public_read`, `org_members`, `admin_only`, `admin_read_all`, `role_based`, `moderator_access`, `all_access` and `custom`. An unrecognised template is refused with the real list.

## Types

`generate_types { format }`: `dts`, `client` or `openapi`, from the live catalog. The result carries `schemaHash`, so you can tell whether a regeneration changed anything. From the shell, `backenly types --client`; `backenly diff` fails in CI when committed types drift.

## REST

`/db/<table>` is live the moment a table exists, resolved from the PostgreSQL catalog per request; there is no API generation step. The one exception is `users`, which is served only through `/auth/*` because it holds password hashes. Headers and grammars are in `client-setup`.

## Direct access

`connect { action: "database_credentials" }` issues a read-only Postgres role on demand, and a read-write role only after a human arms it in the dashboard. `pg_dump` of the workspace schema works. DDL run over a direct connection bypasses the kernel; reconcile it afterwards with `adopt_external_schema`, which updates Backenly's metadata and never emits DDL itself.

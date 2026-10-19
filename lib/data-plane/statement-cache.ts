/**
 * WORKSPACE SQL RUNS WITHOUT PRISMA'S STATEMENT CACHE
 * ===================================================
 * Prisma's query engine keeps a cache of prepared statements on each pooled
 * connection, keyed by the SQL text (`statement_cache_size`, 100 by default):
 * a statement is prepared once and then executed again by name.
 *
 * PostgreSQL will not execute a prepared statement again once its result
 * columns have changed. Workspace SQL reads and returns whole rows (`SELECT *`,
 * `RETURNING *`) of tables whose columns change at any time: an agent adds a
 * column, a rollback drops one. After such a change, the same text on a
 * connection that had prepared it fails with 0A000 "cached plan must not change
 * result type" (Prisma P2010), and keeps failing on that connection until the
 * connection is replaced. Different text (another filter, another LIMIT) works
 * at once, which made it look intermittent. The error is raised before the
 * statement runs, so a refused INSERT wrote nothing; it is not retried here,
 * because retrying cannot help on the same connection.
 *
 * `statement_cache_size=0` makes the engine prepare each statement again and
 * close it after use, so PostgreSQL describes the table as it is now. The cost
 * is the prepare round trip on every statement instead of only the first. It
 * is set only on clients that run workspace SQL: each region's workspace client
 * (lib/data-plane/regional.ts) and a function's own login
 * (lib/services/ai-functions/function-db-role.ts). The platform's client keeps
 * its cache: its tables change only with a release, and its model queries name
 * their columns.
 *
 * Prisma reads the parameter from the PostgreSQL connection string (5.x
 * connector argument `statement_cache_size`).
 * tests/integration/workspace-sql-cached-plan.spec.ts pins the behaviour
 * against a real PostgreSQL.
 */

/** `url` with Prisma's prepared-statement cache switched off. */
export function withoutStatementCache(url: string): string {
  const parsed = new URL(url)
  parsed.searchParams.set('statement_cache_size', '0')
  return parsed.toString()
}

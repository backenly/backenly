/**
 * HOW A LOGIN'S CONNECTIONS ARE SHARED BY THE POOLER'S TWO PORTS
 * ==============================================================
 * A project's login may hold a number of connections at once on the server
 * (PostgreSQL's CONNECTION LIMIT, from the project's plan). The connection
 * pooler is two processes, session pooling on 5432 and transaction pooling on
 * 6543, and both sign in to the server as that login.
 *
 * Each used to size its pool to the whole limit. Two sessions closed on port
 * 5432 then left two idle server connections in that pool for a minute, the
 * limit was spent, and port 6543 refused the same login until they went
 * (production QA, 2026-11-27). The mix Connect recommends, an application on
 * 6543 and migrations on 5432, is the one that met it.
 *
 * So the limit is shared: half to sessions, the rest to transactions, which is
 * where an application's traffic goes. The two pools together are never larger
 * than the limit, whatever either port is doing. A limit of 1 cannot be
 * shared, so each takes it.
 *
 * services/pooler/entrypoint.sh (pool_share) applies this rule when it sizes
 * each database's pool; tests/unit/pooler-image.spec.ts holds the two to the
 * same answers. No imports: the console shows these numbers in the browser.
 */

export interface PoolerPortShares {
  /** Sessions the login may have open at once on port 5432. */
  session: number
  /** Server connections its transactions share on port 6543. */
  transaction: number
}

export function poolerPortShares(limit: number): PoolerPortShares {
  const half = Math.floor(limit / 2)
  return { session: Math.max(half, 1), transaction: limit - half }
}

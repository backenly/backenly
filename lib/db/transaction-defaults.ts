/**
 * How long an interactive transaction waits for a connection from its client's
 * pool before it gives up: as long as a plain query waits for one (Prisma's
 * pool_timeout, 10 s), instead of Prisma's 2 s default for transactions.
 *
 * Every Prisma client this server opens has a small pool: the platform's,
 * a region's workspace client, a data instance's, and each project database's
 * (two connections). The scheduler's fleet passes (instrumentation.ts) take a
 * few connections of those pools for a few seconds at a time. A query that
 * arrived meanwhile waited its turn and succeeded; a transaction that arrived
 * meanwhile failed after 2 s with "Unable to start a transaction in the given
 * time": an end user's sign-up or sign-in, the usage ledger's flush, a graph
 * cleanup, an AI spend settlement. Waiting as long as a query does turns a
 * busy moment back into a slower answer instead of a failed one.
 *
 * Set on each client as `transactionOptions`, so it is only the default: a
 * transaction that names its own maxWait keeps it.
 */
export const TRANSACTION_MAX_WAIT_MS = 10_000

/** The `transactionOptions` every Prisma client this server opens is given. */
export function transactionDefaults(): { maxWait: number } {
  return { maxWait: TRANSACTION_MAX_WAIT_MS }
}

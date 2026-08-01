/**
 * SELFOPS-BENCH — environment pinning
 * ===================================
 *
 * MUST be the first import in any bench entry point. In ESM, imports execute in
 * source order, so importing this module first is what guarantees the rewrite
 * below happens before Prisma or any `pg` Pool reads its connection string.
 *
 * ── The bug this exists to prevent ──────────────────────────────────────────
 *
 * The benchmark reads through its own pool (`BENCH_DATABASE_URL`) but drives the
 * real loop, and the loop's dependencies each open their own connection from
 * `DATABASE_URL`: the Prisma singleton in lib/db/postgres, the pool in
 * lib/autonomy/invariant-probes.ts, and every detector under lib/services.
 *
 * If those two variables disagree, the suite injects faults into one database
 * and lets an autonomous repair loop mutate another. With a normal `.env`
 * loaded, the second one is production. The failure is silent — the oracle
 * would simply report that nothing ever got fixed, while the loop applied real
 * schema changes to real customers.
 *
 * So there is exactly one connection string for a bench run, and everything is
 * pinned to it.
 */

import * as dotenv from 'dotenv'

dotenv.config()

/**
 * The single database a bench run may touch. `BENCH_DATABASE_URL` wins so a
 * developer with a production `.env` on their machine gets the throwaway
 * database, not the other way round.
 */
export const BENCH_DATABASE_URL =
  process.env.BENCH_DATABASE_URL || process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || ''

if (!BENCH_DATABASE_URL) {
  throw new Error(
    'selfops-bench needs a database. Set BENCH_DATABASE_URL to a throwaway Postgres ' +
    '(a CI service container or a local instance).',
  )
}

// Pin every downstream consumer — Prisma, the probe pools, the detectors — to
// the same instance the oracle grades. Without this the loop and the oracle can
// silently address different databases.
process.env.DATABASE_URL = BENCH_DATABASE_URL
process.env.BENCH_DATABASE_URL = BENCH_DATABASE_URL
// Prisma reads DIRECT_URL for non-pooled work; a stale value here would point
// migrations and long queries back at whatever the ambient .env had.
process.env.DIRECT_URL = BENCH_DATABASE_URL

/**
 * Refuse to benchmark production.
 *
 * The suite injects faults, lets an autonomous loop mutate schemas, and drops
 * schemas on teardown. A string check is not real protection, but it catches
 * the realistic accident: running with the ambient .env loaded on a laptop that
 * also deploys.
 */
export function assertNotProduction(): void {
  if (process.argv.includes('--i-know-this-is-not-production')) return
  if (/prod|hetzner|amazonaws|neon\.tech|supabase\.co/i.test(BENCH_DATABASE_URL)) {
    throw new Error(
      `Refusing to run against what looks like a production database ` +
      `(${BENCH_DATABASE_URL.replace(/\/\/[^@]+@/, '//***@')}). This suite injects faults and ` +
      `lets an autonomous loop mutate schemas. Point BENCH_DATABASE_URL at a throwaway instance.`,
    )
  }
}

/** Connection string with credentials stripped, safe to print or publish. */
export function redactedUrl(): string {
  return BENCH_DATABASE_URL.replace(/\/\/[^@]+@/, '//***@')
}

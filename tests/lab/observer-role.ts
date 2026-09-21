/**
 * A PRODUCTION-EQUIVALENT OBSERVER, BECAUSE THE LAB'S OWN ROLE IS NOT ONE
 * ======================================================================
 *
 * Phase 0 ran every scenario through `DATABASE_URL`, and the first Phase 0B
 * check found what that role actually is on a developer machine:
 *
 *     current_user   backenly_user
 *     rolsuper       TRUE
 *     rolbypassrls   false
 *
 * `rolsuper` is decisive. **A superuser bypasses row-level security entirely**,
 * whatever `rolbypassrls` says and whatever FORCE ROW LEVEL SECURITY is set on
 * the table. So the baseline could not have reproduced observation blindness
 * even in principle, and describing it as running "as the NOSUPERUSER
 * NOBYPASSRLS app role" was wrong.
 *
 * This is the `#77` trap restated at the level of the lab: that bug survived for
 * months because it read correctly in development, where the local role happened
 * to be a superuser, and failed in production, where it is not.
 *
 * ── What this module provides ───────────────────────────────────────────────
 *
 * A second role that is deliberately weak:
 *
 *     NOSUPERUSER  NOBYPASSRLS  LOGIN  and NOT the owner of anything
 *
 * Faults that impair observation are measured through THIS connection, while
 * physical truth is established through the owner connection. Two connections,
 * two privilege levels, and a difference between them that is the finding.
 *
 * ── What it deliberately does not claim ─────────────────────────────────────
 *
 * The product's autonomy probes read through the application connection, not
 * through this role. So a fault measured here demonstrates that a
 * production-equivalent reader goes blind; it does not by itself prove the
 * deployed loop goes blind, because that depends on the privileges of the role
 * the deployment actually runs as. The baseline records which is which rather
 * than blurring them.
 */

import { Client } from 'pg'
import type { PrismaClient } from '@prisma/client'

export const OBSERVER_ROLE = 'bkn_lab_observer'
const OBSERVER_PASSWORD = 'lab_observer_not_a_secret'

export interface LabObserver {
  client: Client
  role: string
  /** Close the observer connection. Always call it. */
  close: () => Promise<void>
}

/** True when the connected role bypasses RLS, by superuser or by attribute. */
export async function connectionBypassesRls(prisma: PrismaClient): Promise<{
  user: string
  superuser: boolean
  bypassrls: boolean
  bypasses: boolean
}> {
  const rows = await prisma.$queryRawUnsafe<
    Array<{ u: string; rolsuper: boolean; rolbypassrls: boolean }>
  >(
    `SELECT current_user AS u, rolsuper, rolbypassrls
       FROM pg_roles WHERE rolname = current_user`,
  )
  const r = rows[0]
  return {
    user: r.u,
    superuser: r.rolsuper,
    bypassrls: r.rolbypassrls,
    bypasses: r.rolsuper || r.rolbypassrls,
  }
}

/**
 * Create the observer role if it does not exist. Cluster-wide and idempotent,
 * because it is shared by every scenario in a run.
 */
export async function ensureObserverRole(prisma: PrismaClient): Promise<void> {
  const exists = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1`,
    OBSERVER_ROLE,
  )
  if (exists[0].n === 0) {
    await prisma.$executeRawUnsafe(
      `CREATE ROLE "${OBSERVER_ROLE}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE ` +
        `PASSWORD '${OBSERVER_PASSWORD}'`,
    )
  }
  // Re-assert the weak attributes even when the role pre-existed: a role left
  // behind by another run with different flags would silently make every
  // blindness fault unreproducible, which is the failure this file exists to
  // prevent.
  await prisma.$executeRawUnsafe(
    `ALTER ROLE "${OBSERVER_ROLE}" NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN`,
  )
}

/** Let the observer read a workspace schema, as a client role would. */
export async function grantObserverAccess(
  prisma: PrismaClient,
  schema: string,
): Promise<void> {
  await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${schema}" TO "${OBSERVER_ROLE}"`)
  await prisma.$executeRawUnsafe(
    `GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO "${OBSERVER_ROLE}"`,
  )
}

/** Connect as the observer, reusing the app connection's host/database. */
export async function connectObserver(databaseUrl: string): Promise<LabObserver> {
  const url = new URL(databaseUrl)
  url.username = OBSERVER_ROLE
  url.password = OBSERVER_PASSWORD
  // The observer must not inherit pooling or schema parameters intended for the
  // application role.
  url.search = ''

  const client = new Client({ connectionString: url.toString() })
  await client.connect()

  const who = await client.query(
    `SELECT current_user AS u, rolsuper, rolbypassrls
       FROM pg_roles WHERE rolname = current_user`,
  )
  const r = who.rows[0]
  if (r.rolsuper || r.rolbypassrls) {
    await client.end()
    throw new Error(
      `Observer role ${r.u} bypasses RLS (super=${r.rolsuper} bypass=${r.rolbypassrls}). ` +
        'Blindness cannot be reproduced through it, so the measurement would be vacuous.',
    )
  }

  return { client, role: r.u, close: () => client.end() }
}

/** What the observer can count in a table. RLS applies to this read. */
export async function observerRowCount(
  obs: LabObserver,
  schema: string,
  table: string,
): Promise<{ visible: number; error: string | null }> {
  try {
    const res = await obs.client.query(`SELECT count(*)::int AS n FROM "${schema}"."${table}"`)
    return { visible: res.rows[0].n, error: null }
  } catch (e: any) {
    // A permission failure is an honest "cannot observe", not zero rows. The
    // caller must keep those apart; collapsing them is exactly #77.
    return { visible: -1, error: e?.message?.split('\n')[0] ?? String(e) }
  }
}

/** How many tables the observer can see in the schema's catalog. */
export async function observerTableCount(
  obs: LabObserver,
  schema: string,
): Promise<{ visible: number; error: string | null }> {
  try {
    const res = await obs.client.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1`,
      [schema],
    )
    return { visible: res.rows[0].n, error: null }
  } catch (e: any) {
    return { visible: -1, error: e?.message?.split('\n')[0] ?? String(e) }
  }
}

/**
 * Physical row count that RLS cannot filter.
 *
 * `pg_class.reltuples` is planner statistics, not a row read, so it is visible
 * regardless of policies. After the seeder's ANALYZE it is exact enough to tell
 * "this table holds 60 rows" from "this table is empty", which is the only
 * distinction a blindness fault needs — and it is an oracle the observer's own
 * privileges cannot influence.
 */
export async function physicalRowEstimate(
  prisma: PrismaClient,
  schema: string,
  table: string,
): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT c.reltuples::int AS n
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2`,
    schema,
    table,
  )
  return rows.length > 0 ? rows[0].n : -1
}

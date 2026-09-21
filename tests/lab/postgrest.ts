/**
 * MAKE THE LAB'S TABLES REACHABLE THE WAY PRODUCTION'S ARE
 * =======================================================
 *
 * `detectMissingRls` only reports a table that is CLIENT-REACHABLE:
 *
 *     RLS is off  AND  anon or authenticated can SELECT it
 *
 * That is deliberate, and it mirrors `backenly_pgrst_cutover_blockers` check #2.
 * A table nobody can reach is not an exposure.
 *
 * The seeder creates tables with raw DDL and grants nothing, so a lab table is
 * unreachable and the detector is right to stay silent about it. The first
 * Phase 0 run scored that silence as an `enable_rls` FALSE NEGATIVE, which was
 * a claim about the product derived entirely from a gap in the lab.
 *
 * ── Why it is worse than a wrong number ─────────────────────────────────────
 *
 * The detector's reachability clause has a fallback:
 *
 *     NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon','authenticated'))
 *     OR has_table_privilege('anon', …) OR has_table_privilege('authenticated', …)
 *
 * so when those roles are ABSENT every table counts as reachable. Other suites
 * in this repo create those roles cluster-wide and deliberately leave them, so
 * whether the fallback applies depends on what else has run against the same
 * PostgreSQL. The same scenario would mean different things on different days.
 *
 * Preparing the schema explicitly removes that dependency: the tables are
 * reachable because this file made them reachable, not because a role happened
 * to be missing.
 */

import type { PrismaClient } from '@prisma/client'

/** The PostgREST client roles, in the order `prepare_schema` grants to them. */
const CLIENT_ROLES = ['anon', 'authenticated', 'service_role'] as const

export interface PrepareResult {
  /** True when the real production function was used. */
  usedProductionFunction: boolean
  /** Roles that existed and were granted. */
  grantedTo: string[]
  /** Roles named by production that this cluster does not have. */
  missingRoles: string[]
}

async function roleExists(prisma: PrismaClient, role: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1`,
    role,
  )
  return rows[0].n > 0
}

async function functionExists(prisma: PrismaClient, name: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM pg_proc WHERE proname = $1`,
    name,
  )
  return rows[0].n > 0
}

/**
 * Expose a workspace schema to the PostgREST client roles.
 *
 * Prefers the real `backenly_pgrst_prepare_schema`, so that when the support SQL
 * IS installed the lab is exercising production's own code rather than a
 * paraphrase of it. Falls back to the exact grants that function performs, for
 * developer databases where `scripts/sql/postgrest-ddl-sync.sql` has not been
 * applied.
 *
 * The fallback is a transcription and can drift. If these two ever disagree,
 * the function is right and this file is stale.
 */
export async function prepareForPostgrest(
  prisma: PrismaClient,
  schema: string,
): Promise<PrepareResult> {
  const present: string[] = []
  const missing: string[] = []
  for (const r of CLIENT_ROLES) {
    ;(await roleExists(prisma, r) ? present : missing).push(r)
  }

  if (present.length === 0) {
    throw new Error(
      'None of anon/authenticated/service_role exist. The lab cannot make a ' +
        'table client-reachable, so RLS reachability cannot be measured here.',
    )
  }

  if (await functionExists(prisma, 'backenly_pgrst_prepare_schema')) {
    await prisma.$executeRawUnsafe(`SELECT public.backenly_pgrst_prepare_schema($1)`, schema)
    return { usedProductionFunction: true, grantedTo: present, missingRoles: missing }
  }

  // Transcribed from public.backenly_pgrst_prepare_schema in
  // scripts/sql/postgrest-ddl-sync.sql. Only roles this cluster actually has
  // are named: GRANT to an absent role is an error, and failing the whole
  // preparation over a missing service_role would make the lab unusable on a
  // developer machine.
  const write = present.filter(r => r === 'authenticated' || r === 'service_role')
  await prisma.$executeRawUnsafe(
    `GRANT USAGE ON SCHEMA "${schema}" TO ${present.map(r => `"${r}"`).join(', ')}`,
  )
  if (write.length > 0) {
    await prisma.$executeRawUnsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" ` +
        `TO ${write.map(r => `"${r}"`).join(', ')}`,
    )
    await prisma.$executeRawUnsafe(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" ` +
        `TO ${write.map(r => `"${r}"`).join(', ')}`,
    )
  }
  if (present.includes('anon')) {
    await prisma.$executeRawUnsafe(
      `GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO "anon"`,
    )
  }

  return { usedProductionFunction: false, grantedTo: present, missingRoles: missing }
}

/** Ground truth: can this role SELECT this table? */
export async function canSelect(
  prisma: PrismaClient,
  role: string,
  schema: string,
  table: string,
): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ ok: boolean }>>(
    `SELECT has_table_privilege($1, ($2 || '.' || quote_ident($3))::regclass, 'SELECT') AS ok`,
    role,
    `"${schema}"`,
    table,
  )
  return rows[0].ok
}

/**
 * Is this table reachable by a PostgREST client, by the same rule the detector
 * uses? Asked of the database, not of the detector.
 */
export async function isClientReachable(
  prisma: PrismaClient,
  schema: string,
  table: string,
): Promise<boolean> {
  for (const r of ['anon', 'authenticated']) {
    if (await roleExists(prisma, r)) {
      if (await canSelect(prisma, r, schema, table)) return true
    }
  }
  return false
}

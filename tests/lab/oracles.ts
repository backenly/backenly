/**
 * GROUND-TRUTH ORACLES — what is actually true of the database
 * ============================================================
 *
 * Phase 0 measures the current autonomy system. That measurement is worthless
 * if it asks the system under test whether it succeeded, which is the mistake
 * `#79` was: a verifier that threw was recorded as success, and every surface
 * above it agreed, because they all read the same claim.
 *
 * So every function here reads `pg_catalog` directly, over a plain connection,
 * and shares no code path with `lib/autonomy/`. Not `resolveWorkspaceSchema`,
 * not the probes, not the desired-state report, not a Prisma model. The schema
 * name is passed in by the caller, because resolving it through the product's
 * own helper would import the assumption under test.
 *
 * If an oracle and a probe ever disagree, the oracle is right by construction:
 * it is asking PostgreSQL, and the probe is asking a belief about PostgreSQL.
 *
 * ── On failure ──────────────────────────────────────────────────────────────
 *
 * These deliberately do NOT catch. A failed oracle read must crash the harness
 * run rather than return a plausible default, because `catch(() => [])` turning
 * an unreadable schema into "no tables" is the exact defect `#83` fixed. A
 * baseline that silently scored a scenario against a failed observation would
 * be the same bug wearing a lab coat.
 */

import type { PrismaClient } from '@prisma/client'

/** Raw catalog query. Unsafe-by-name, parameterised in practice. */
async function q<T>(prisma: PrismaClient, sql: string, ...params: unknown[]): Promise<T[]> {
  return prisma.$queryRawUnsafe<T[]>(sql, ...params)
}

/** Is row-level security enabled on this table, and is it forced? */
export async function rlsState(
  prisma: PrismaClient,
  schema: string,
  table: string,
): Promise<{ exists: boolean; enabled: boolean; forced: boolean }> {
  const rows = await q<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    prisma,
    `SELECT c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'`,
    schema,
    table,
  )
  if (rows.length === 0) return { exists: false, enabled: false, forced: false }
  return { exists: true, enabled: rows[0].relrowsecurity, forced: rows[0].relforcerowsecurity }
}

/** How many policies exist on this table, and what are they called? */
export async function policies(
  prisma: PrismaClient,
  schema: string,
  table: string,
): Promise<string[]> {
  const rows = await q<{ policyname: string }>(
    prisma,
    `SELECT policyname FROM pg_policies
      WHERE schemaname = $1 AND tablename = $2
      ORDER BY policyname`,
    schema,
    table,
  )
  return rows.map(r => r.policyname)
}

/** Does a FOREIGN KEY constraint cover this column? */
export async function hasForeignKey(
  prisma: PrismaClient,
  schema: string,
  table: string,
  column: string,
): Promise<boolean> {
  const rows = await q<{ n: number }>(
    prisma,
    `SELECT count(*)::int AS n
       FROM pg_constraint con
       JOIN pg_class c     ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (con.conkey)
      WHERE n.nspname = $1 AND c.relname = $2
        AND con.contype = 'f' AND a.attname = $3`,
    schema,
    table,
    column,
  )
  return rows[0].n > 0
}

/** Does any index cover this column? Names returned so a diff can be reported. */
export async function indexesOn(
  prisma: PrismaClient,
  schema: string,
  table: string,
  column: string,
): Promise<string[]> {
  const rows = await q<{ indexname: string }>(
    prisma,
    `SELECT ic.relname AS indexname
       FROM pg_index i
       JOIN pg_class c     ON c.oid = i.indrelid
       JOIN pg_class ic    ON ic.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attname = $3
      ORDER BY ic.relname`,
    schema,
    table,
    column,
  )
  return rows.map(r => r.indexname)
}

/** Every index in the schema, as a stable fingerprint for before/after diffs. */
export async function indexFingerprint(
  prisma: PrismaClient,
  schema: string,
): Promise<string[]> {
  const rows = await q<{ sig: string }>(
    prisma,
    `SELECT (c.relname || '.' || ic.relname) AS sig
       FROM pg_index i
       JOIN pg_class c     ON c.oid = i.indrelid
       JOIN pg_class ic    ON ic.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
      ORDER BY 1`,
    schema,
  )
  return rows.map(r => r.sig)
}

/** Full structural fingerprint: tables, columns, RLS, policies, FKs, indexes. */
export async function schemaFingerprint(
  prisma: PrismaClient,
  schema: string,
): Promise<Record<string, unknown>> {
  const tables = await q<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    prisma,
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r'
      ORDER BY c.relname`,
    schema,
  )
  const cols = await q<{ table_name: string; column_name: string; data_type: string }>(
    prisma,
    `SELECT table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = $1
      ORDER BY table_name, column_name`,
    schema,
  )
  const pol = await q<{ tablename: string; policyname: string }>(
    prisma,
    `SELECT tablename, policyname FROM pg_policies
      WHERE schemaname = $1 ORDER BY tablename, policyname`,
    schema,
  )
  // Constraints belong in the fingerprint. Leaving them out made `fk-dropped`
  // score as "the fault did nothing": the FK vanished from the database and the
  // fingerprint was byte-identical, so the harness could not tell a dropped
  // constraint from a no-op. A fingerprint that cannot see a change cannot
  // measure a repair of it either.
  const cons = await q<{ relname: string; conname: string; contype: string }>(
    prisma,
    `SELECT c.relname, con.conname, con.contype::text
       FROM pg_constraint con
       JOIN pg_class c     ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
      ORDER BY c.relname, con.conname`,
    schema,
  )

  return {
    // FORCE is recorded separately from ENABLE because it is the flag that
    // binds the table OWNER, and the owner is the role a pooled connection is
    // most likely running as. A fingerprint that saw only ENABLE could not tell
    // a protected table from one the observer still bypasses.
    tables: tables.map(t => ({
      name: t.relname,
      rls: t.relrowsecurity,
      forced: t.relforcerowsecurity,
    })),
    columns: cols.map(c => `${c.table_name}.${c.column_name}:${c.data_type}`),
    policies: pol.map(p => `${p.tablename}.${p.policyname}`),
    constraints: cons.map(c => `${c.relname}.${c.conname}:${c.contype}`),
    indexes: await indexFingerprint(prisma, schema),
  }
}

/**
 * Can this schema be observed at all?
 *
 * The distinction `#83` turned on: a readable-but-empty schema and an
 * unreadable one both yield zero tables, and only one of them means "nothing is
 * there". Establishing observability separately is what makes a zero count
 * mean something.
 */
export async function schemaIsObservable(
  prisma: PrismaClient,
  schema: string,
): Promise<boolean> {
  const rows = await q<{ n: number }>(
    prisma,
    `SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1`,
    schema,
  )
  return rows[0].n > 0
}

/** Physical row count, read as the table owner so RLS cannot hide rows (`#77`). */
export async function physicalRowCount(
  prisma: PrismaClient,
  schema: string,
  table: string,
): Promise<number> {
  const rows = await q<{ n: bigint }>(
    prisma,
    `SELECT count(*)::bigint AS n FROM "${schema}"."${table}"`,
  )
  return Number(rows[0].n)
}

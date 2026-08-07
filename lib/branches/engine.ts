/**
 * Preview-branch engine — clone, diff, merge (additive), discard.
 *
 * The economics are the point: on Backenly's multi-tenant architecture a
 * branch is one CREATE SCHEMA plus per-table LIKE-clones — effectively free,
 * where instance-per-project competitors pay for a whole machine per
 * environment.
 *
 * v1 contract (foundation):
 *   • create   — full structural clone (LIKE … INCLUDING ALL: types, defaults,
 *                NOT NULL, indexes) + data copy. FK constraints intentionally
 *                not cloned — the branch is a sandbox, not a runtime.
 *   • diff     — pure comparison (lib/branches/diff.ts) of branch vs main.
 *   • merge    — NEW TABLES apply to main through executeAction (the governed
 *                kernel: metadata, generated APIs, auto-RLS, reconciler all
 *                fire). Added columns / type changes / drops are NOT auto-
 *                applied — they return as review items for the governed chat
 *                or approval path. Honest ceiling, no silent DDL.
 *   • discard  — DROP SCHEMA CASCADE, registry-guarded.
 *
 * Operating ON a branch (pointing the brain/runtime at it) is the next
 * integration step and deliberately not faked here.
 */

import { Pool } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { executeAction } from '@/lib/ai/minimal-executor'
import { readWorkspaceSchema } from '@/lib/typegen/schema-reader'
import { mapPgType } from '@/lib/import/supabase-map'
import { computeSchemaDiff, validateBranchName, branchSchemaName, type SchemaDiff } from './diff'
import { replicateRls, verifyRlsParity, type RlsCloneResult } from './rls-clone'
import { registerSchemaByName } from '@/lib/postgrest/registration'

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
const MAX_ACTIVE_BRANCHES = 5

/** Read a WorkspaceSchema-shaped snapshot for an arbitrary schema name. */
async function readSchemaSnapshot(projectId: string, schemaName: string) {
  const res = await pool.query(
    `SELECT table_name, column_name, data_type, udt_name, is_nullable = 'YES' AS is_nullable
       FROM information_schema.columns
      WHERE table_schema = $1
      ORDER BY table_name, ordinal_position`,
    [schemaName],
  )
  const tables = new Map<string, { tableName: string; columns: any[] }>()
  for (const r of res.rows) {
    if (r.table_name.startsWith('_')) continue // reserved plumbing
    let t = tables.get(r.table_name)
    if (!t) {
      t = { tableName: r.table_name, columns: [] }
      tables.set(r.table_name, t)
    }
    t.columns.push({
      tableName: r.table_name,
      columnName: r.column_name,
      dataType: r.data_type,
      udtName: r.udt_name,
      isNullable: r.is_nullable,
      columnDefault: null,
      isPrimaryKey: false,
      isForeignKey: false,
      ordinalPosition: t.columns.length + 1,
    })
  }
  return { projectId, schemaName, tables: [...tables.values()], generatedAt: new Date().toISOString() }
}

export interface CreateBranchOptions {
  /**
   * Copy main's rows into the branch. OFF by default, and that default is the
   * important part.
   *
   * Supabase ships the same feature with the same default and states the reason
   * outright: "New branches do not start with any data from your main project.
   * This is meant to better protect your sensitive production data." A branch is
   * for testing a schema change, and a full copy of production multiplies the
   * blast radius of every mistake made against it.
   *
   * When it IS requested, RLS is replicated first (see below), so the copy is
   * governed by the same policies as the original rather than lying open.
   */
  includeData?: boolean
}

export async function createBranch(
  projectId: string,
  userId: string,
  rawName: string,
  options: CreateBranchOptions = {},
) {
  // Normalize BEFORE validation and use the slug everywhere — the validator
  // lowercases internally, so "Add-Payments" must become "add-payments" here
  // or the schema identifier and registry would carry the un-normalized form.
  const name = rawName.trim().toLowerCase()
  const nameError = validateBranchName(name)
  if (nameError) return { ok: false as const, error: nameError }

  const active = await prisma.workspaceBranch.count({ where: { projectId, status: 'active' } })
  if (active >= MAX_ACTIVE_BRANCHES) {
    return { ok: false as const, error: `Branch limit reached (${MAX_ACTIVE_BRANCHES} active) — merge or discard one first.` }
  }
  const dupe = await prisma.workspaceBranch.findFirst({ where: { projectId, name, status: 'active' } })
  if (dupe) return { ok: false as const, error: `A branch named "${name}" already exists.` }

  const mainSchema = `workspace_${projectId}`
  const schemaName = branchSchemaName(projectId, name)
  const main = await readWorkspaceSchema(projectId)

  const includeData = options.includeData === true
  let rls: RlsCloneResult = { policiesCreated: 0, tablesEnabled: 0, tablesForced: 0, failures: [] }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`CREATE SCHEMA "${schemaName}"`)
    for (const t of main.tables) {
      await client.query(
        `CREATE TABLE "${schemaName}"."${t.tableName}" (LIKE "${mainSchema}"."${t.tableName}" INCLUDING ALL)`,
      )
    }

    // ── Row security, before any data exists ──────────────────────────────
    //
    // INCLUDING ALL does not copy RLS: not the flag, not FORCE, not one policy.
    // Verified on PG 16, not read from the docs — a clone came up with
    // relrowsecurity = false and a non-privileged role saw every fixture row.
    //
    // Ordered before the data copy on purpose. Replicating afterwards would
    // leave a window, however short, in which a full copy of production sits in
    // a schema with no policies on it.
    rls = await replicateRls(client, mainSchema, schemaName)
    if (rls.failures.length > 0) {
      // A branch missing even one policy is a hole, and a hole reported as a
      // ready branch is exactly the failure this ordering exists to prevent.
      throw new Error(
        `could not replicate ${rls.failures.length} row-security policy/policies ` +
        `(${rls.failures[0].table}.${rls.failures[0].policy}: ${rls.failures[0].error})`,
      )
    }

    if (includeData) {
      for (const t of main.tables) {
        await client.query(
          `INSERT INTO "${schemaName}"."${t.tableName}" SELECT * FROM "${mainSchema}"."${t.tableName}"`,
        )
      }
    }

    // Belt and braces: assert against the live catalog that the branch is at
    // least as protected as main, rather than trusting the return value above.
    const parity = await verifyRlsParity(client, mainSchema, schemaName)
    if (!parity.ok) throw new Error(parity.reason ?? 'row-security parity check failed')

    await client.query('COMMIT')
  } catch (e: any) {
    await client.query('ROLLBACK').catch(() => {})
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => {})
    return { ok: false as const, error: `Branch clone failed: ${e?.message ?? 'unknown error'}` }
  } finally {
    client.release()
  }

  // ── Make the branch servable ──────────────────────────────────────────────
  //
  // PostgREST's exposed-schema list is static configuration; a schema missing
  // from it answers PGRST106 for every table. Registration is what turns the
  // clone from a sandbox into an environment a key can be pointed at.
  //
  // It is reached only because RLS was replicated and parity was verified above.
  // registerSchemaByName re-checks that independently before it will accept a
  // `_br_` schema, so this is a request rather than an assertion.
  const reg = await registerSchemaByName(schemaName).catch((e: any) => ({
    registered: false, schema: schemaName, error: e?.message ?? String(e),
  }))
  if (!reg.registered) {
    // Refuse the whole branch rather than leave one that cannot be served. A
    // branch whose API 404s is indistinguishable from a broken backend, and the
    // user has no way to tell which they are looking at.
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => {})
    return {
      ok: false as const,
      error: `Branch created but could not be served: ${reg.error ?? 'registration failed'}`,
    }
  }

  const row = await prisma.workspaceBranch.create({
    data: { projectId, name, schemaName, createdBy: userId },
  })
  await audit(projectId, userId, 'BRANCH_CREATED', {
    branch: name,
    tables: main.tables.length,
    includeData,
    policiesReplicated: rls.policiesCreated,
    tablesForced: rls.tablesForced,
  })
  return {
    ok: true as const,
    branch: row,
    tablesCloned: main.tables.length,
    dataCopied: includeData,
    policiesReplicated: rls.policiesCreated,
  }
}

export async function diffBranch(projectId: string, branchId: string): Promise<
  | { ok: true; diff: SchemaDiff; branch: string }
  | { ok: false; error: string }
> {
  const branch = await prisma.workspaceBranch.findFirst({
    where: { id: branchId, projectId, status: 'active' },
  })
  if (!branch) return { ok: false, error: 'Branch not found or not active' }

  const [main, br] = await Promise.all([
    readSchemaSnapshot(projectId, `workspace_${projectId}`),
    readSchemaSnapshot(projectId, branch.schemaName),
  ])
  return { ok: true, branch: branch.name, diff: computeSchemaDiff(main as any, br as any) }
}

export async function mergeBranch(projectId: string, userId: string, branchId: string) {
  const result = await diffBranch(projectId, branchId)
  // Re-shape the early return explicitly — passing `result` through would leak
  // diffBranch's ok-variant into mergeBranch's inferred return union (this
  // tsconfig doesn't narrow boolean discriminants).
  if (!result.ok) {
    return { ok: false as const, error: (result as { ok: false; error: string }).error }
  }
  const d = result as Extract<Awaited<ReturnType<typeof diffBranch>>, { ok: true }>

  const applied: string[] = []
  const review: string[] = []

  // Additive: new tables go to main through the governed kernel.
  for (const t of d.diff.addedTables) {
    const columns = t.columns
      .filter((c: any) => !['id', 'createdAt', 'updatedAt'].includes(c.columnName))
      .map((c: any) => {
        const mapped = mapPgType({
          name: c.columnName,
          dataType: c.dataType,
          udtName: c.udtName,
          isNullable: c.isNullable,
          isPrimaryKey: false,
          referencedTable: null,
          referencedColumn: null,
          hasDefault: false,
        })
        return { name: c.columnName, type: mapped.type }
      })
    const result: any = await executeAction(
      { type: 'CREATE_TABLE', params: { tableName: t.tableName, columns } } as any,
      projectId,
      undefined,
    )
    if (result?.success === false) {
      review.push(`Table "${t.tableName}" could not be created: ${result.error ?? 'unknown'} — bring it over via chat`)
    } else {
      applied.push(`Created table "${t.tableName}" (${columns.length} columns) with generated APIs`)
    }
  }

  // Everything non-additive is a review item — the governed paths own those.
  for (const a of d.diff.altered) {
    for (const c of a.addedColumns) review.push(`Add column ${a.table}.${c.name} (${c.dataType}) — ask the agent: "add ${c.name} to ${a.table}"`)
    for (const c of a.droppedColumns) review.push(`Column ${a.table}.${c} was dropped on the branch — destructive, needs the approval path`)
    for (const tc of a.typeChanged) review.push(`${a.table}.${tc.column} changed type ${tc.from} → ${tc.to} — a data migration, not a merge`)
  }
  for (const t of d.diff.droppedTables) {
    review.push(`Table "${t}" was dropped on the branch — destructive, needs the approval path`)
  }

  if (applied.length > 0 || d.diff.identical) {
    await prisma.workspaceBranch.update({
      where: { id: branchId },
      data: review.length === 0 ? { status: 'merged', mergedAt: new Date() } : {},
    })
  }
  await audit(projectId, userId, 'BRANCH_MERGED', {
    branch: d.branch, applied: applied.length, review: review.length,
  })
  return { ok: true as const, branch: d.branch, applied, review, fullyMerged: review.length === 0 }
}

export async function discardBranch(projectId: string, userId: string, branchId: string) {
  const branch = await prisma.workspaceBranch.findFirst({
    where: { id: branchId, projectId, status: { in: ['active', 'merged'] } },
  })
  if (!branch) return { ok: false as const, error: 'Branch not found' }
  // Registry-guarded: only schemas this table owns can be dropped.
  if (!branch.schemaName.startsWith(`workspace_${projectId}_br_`)) {
    return { ok: false as const, error: 'Refusing to drop a non-branch schema' }
  }
  // Unregister BEFORE dropping. A registered schema that no longer exists fails
  // PostgREST's whole schema-cache rebuild, which 503s every tenant on the box,
  // not just this project. The event trigger prunes dangling entries as a
  // backstop, but ordering it correctly here means the backstop is never needed.
  try {
    const { unregisterSchema } = await import('@/lib/postgrest/registration')
    await unregisterSchema(branch.schemaName)
  } catch (e: any) {
    console.warn(`[Branch] PostgREST unregister failed for ${branch.schemaName}:`, e?.message)
  }
  await pool.query(`DROP SCHEMA IF EXISTS "${branch.schemaName}" CASCADE`)
  await prisma.workspaceBranch.update({
    where: { id: branch.id },
    data: { status: 'discarded', discardedAt: new Date() },
  })
  await audit(projectId, userId, 'BRANCH_DISCARDED', { branch: branch.name })
  return { ok: true as const }
}

export async function listBranches(projectId: string) {
  return prisma.workspaceBranch.findMany({
    where: { projectId, status: { not: 'discarded' } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, status: true, createdAt: true, mergedAt: true },
  })
}

async function audit(projectId: string, userId: string, action: string, details: Record<string, unknown>) {
  await prisma.auditLog
    .create({
      data: {
        projectId, userId, action, type: 'branch',
        details: JSON.stringify({ ...details, at: new Date().toISOString() }),
        timestamp: new Date(),
      },
    })
    .catch(() => {})
}

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

export async function createBranch(projectId: string, userId: string, rawName: string) {
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

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`CREATE SCHEMA "${schemaName}"`)
    for (const t of main.tables) {
      await client.query(
        `CREATE TABLE "${schemaName}"."${t.tableName}" (LIKE "${mainSchema}"."${t.tableName}" INCLUDING ALL)`,
      )
      await client.query(
        `INSERT INTO "${schemaName}"."${t.tableName}" SELECT * FROM "${mainSchema}"."${t.tableName}"`,
      )
    }
    await client.query('COMMIT')
  } catch (e: any) {
    await client.query('ROLLBACK').catch(() => {})
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => {})
    return { ok: false as const, error: `Branch clone failed: ${e?.message ?? 'unknown error'}` }
  } finally {
    client.release()
  }

  // ── Deliberately NOT registered with PostgREST ────────────────────────────
  //
  // A branch is a schema sandbox: you diff it and merge it. It is NOT served
  // over the REST API, and that is a security position rather than an omission.
  //
  // Measured on Postgres 16, 2026-08-07: the `LIKE ... INCLUDING ALL` clone
  // above copies indexes, defaults and constraints but NOT row security. The
  // branch comes up with relrowsecurity = false and zero policies, and a
  // non-privileged end-user role reading it saw every row. Serving that would
  // publish an unprotected copy of the project's data under a schema name no
  // dashboard shows.
  //
  // Making branches servable therefore requires replicating RLS into the clone
  // first, and only then widening the registry's canonical-name check. See
  // registerSchemaByName, which refuses branch schemas explicitly so the gap
  // cannot be closed by accident.
  const row = await prisma.workspaceBranch.create({
    data: { projectId, name, schemaName, createdBy: userId },
  })
  await audit(projectId, userId, 'BRANCH_CREATED', { branch: name, tables: main.tables.length })
  return { ok: true as const, branch: row, tablesCloned: main.tables.length }
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

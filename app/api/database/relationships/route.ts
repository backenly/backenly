export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { z } from 'zod'

const querySchema = z.object({
  schema: z.string().optional(),
  table: z.string().optional(),
  projectId: z.string().optional(),
})

const SEMANTIC_FK_COLS = new Set([
  'owner', 'creator', 'author', 'assignee', 'reviewer',
  'approver', 'manager', 'moderator', 'editor', 'sender',
  'recipient', 'host', 'organizer',
])

/**
 * Layer 1: Real PostgreSQL FOREIGN KEY constraints — authoritative source.
 */
async function queryDbRelationships(pgSchema: string, tableFilter?: string) {
  const { prisma } = await import('@/lib/db/prisma')
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{
      table_name: string
      column_name: string
      referenced_table: string
      referenced_column: string
      constraint_name: string
    }>>(
      `SELECT
         kcu.table_name,
         kcu.column_name,
         ccu.table_name  AS referenced_table,
         ccu.column_name AS referenced_column,
         tc.constraint_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema   = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name
         AND tc.table_schema   = ccu.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = $1
         ${tableFilter ? `AND (kcu.table_name = $2 OR ccu.table_name = $2)` : ''}`,
      ...(tableFilter ? [pgSchema, tableFilter] : [pgSchema])
    )
    return rows.map(r => ({
      name: r.constraint_name,
      type: 'foreign_key' as const,
      relationType: 'one-to-many' as const,
      from: { table: r.referenced_table, column: r.referenced_column },
      to:   { table: r.table_name,       column: r.column_name },
    }))
  } catch {
    return []
  }
}

/**
 * Layer 2: Direct column-name inference — works even when FK constraints were
 * stripped during creation (referenced table didn't exist yet) and works even
 * when no BackendGraph record exists for the project.
 *
 * Handles: snake_case (*_id), camelCase (*Id), semantic cols, junction tables.
 */
async function inferRelationshipsFromColumns(pgSchema: string, tableFilter?: string) {
  const { prisma } = await import('@/lib/db/prisma')
  try {
    const tableRows = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
      pgSchema
    )
    const tableNames = new Set(tableRows.map(r => r.table_name))
    // Case-insensitive map: lowercase → actual name (handles PascalCase tables like "Tasks", "Projects")
    const tableNameMap = new Map<string, string>()
    for (const { table_name } of tableRows) {
      tableNameMap.set(table_name.toLowerCase(), table_name)
    }
    if (tableNames.size === 0) return []

    const allCols = await prisma.$queryRawUnsafe<{ table_name: string; column_name: string }[]>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = $1 AND column_name != 'id'`,
      pgSchema
    )

    // Group columns by table
    const tableColMap = new Map<string, string[]>()
    for (const { table_name, column_name } of allCols) {
      if (!tableColMap.has(table_name)) tableColMap.set(table_name, [])
      tableColMap.get(table_name)!.push(column_name)
    }

    type Rel = { name: string; type: string; relationType: string; from: { table: string; column: string }; to: { table: string; column: string } }
    const relations: Rel[] = []
    const seen = new Set<string>()

    const addRel = (parentTable: string, childTable: string, fkCol: string, relType = 'one-to-many') => {
      const key = `${parentTable}.id->${childTable}.${fkCol}`
      if (seen.has(key)) return
      seen.add(key)
      relations.push({
        name: `${parentTable}_${childTable}_${fkCol}_fk`,
        type: relType === 'many-to-many' ? 'many-to-many' : 'foreign_key',
        relationType: relType,
        from: { table: parentTable, column: 'id' },
        to:   { table: childTable,  column: fkCol },
      })
    }

    for (const [tableName, cols] of tableColMap) {
      for (const col of cols) {
        const lower = col.toLowerCase()

        // snake_case: user_id → users table
        if (lower.endsWith('_id')) {
          const base = lower.slice(0, -3)

          // Semantic _id columns: assignee_id / creator_id / author_id → users
          // Case-insensitive: "Users" table matches lookup for "users"
          const usersTable = tableNameMap.get('users')
          if (SEMANTIC_FK_COLS.has(base) && usersTable && tableName.toLowerCase() !== 'users') {
            addRel(usersTable, tableName, col)
            continue
          }

          // Standard name-based lookup: project_id → projects / project
          // Case-insensitive: "Projects" matches lookup for "projects"
          // Also handle irregular plurals: category → categories, person → people
          const irregularPlurals: Record<string, string> = {
            person: 'people', category: 'categories', company: 'companies',
            country: 'countries', city: 'cities', activity: 'activities',
            entity: 'entities', property: 'properties', entry: 'entries',
          }
          const parent = tableNameMap.get(`${base}s`)
                       ?? tableNameMap.get(base)
                       ?? (irregularPlurals[base] ? tableNameMap.get(irregularPlurals[base]) : null)
                       ?? null
          if (parent && parent.toLowerCase() !== tableName.toLowerCase()) {
            addRel(parent, tableName, col)
          }
          continue
        }

        // camelCase: userId → users (only mixed-case columns, not all-lowercase)
        if (/[a-z]id$/.test(lower) && col !== col.toLowerCase()) {
          const base = lower.slice(0, -2)

          // Semantic camelCase: assigneeId / creatorId → users
          const usersTableC = tableNameMap.get('users')
          if (SEMANTIC_FK_COLS.has(base) && usersTableC && tableName.toLowerCase() !== 'users') {
            addRel(usersTableC, tableName, col)
            continue
          }

          const parent = tableNameMap.get(`${base}s`) ?? tableNameMap.get(base) ?? null
          if (parent && parent.toLowerCase() !== tableName.toLowerCase()) {
            addRel(parent, tableName, col)
          }
          continue
        }

        // Semantic columns: owner / creator / author → users
        const usersTableS = tableNameMap.get('users')
        if (SEMANTIC_FK_COLS.has(lower) && usersTableS && tableName.toLowerCase() !== 'users') {
          addRel(usersTableS, tableName, col)
        }
      }
    }

    // Junction table detection: tables with 2+ FK columns pointing to different
    // parents are many-to-many junction tables — promote relation type.
    const fkCountByChild = new Map<string, number>()
    for (const rel of relations) {
      fkCountByChild.set(rel.to.table, (fkCountByChild.get(rel.to.table) || 0) + 1)
    }
    for (const rel of relations) {
      if ((fkCountByChild.get(rel.to.table) || 0) >= 2) {
        rel.relationType = 'many-to-many'
        rel.type = 'many-to-many'
      }
    }

    if (tableFilter) {
      return relations.filter(r => r.from.table === tableFilter || r.to.table === tableFilter)
    }
    return relations
  } catch {
    return []
  }
}

/**
 * GET /api/database/relationships
 *
 * ?table=<name>  → relationships for one table
 * (no table)     → ALL relationships for the project
 */
export const GET = withProjectAccess(async (request: NextRequest, { user, project, projectId }) => {
  try {
    const searchParams = request.nextUrl.searchParams
    const validated = querySchema.parse({
      schema: searchParams.get('schema') || undefined,
      table: searchParams.get('table') || undefined,
      projectId: searchParams.get('projectId') || undefined,
    })

    const targetProjectId = validated.projectId || projectId
    if (!targetProjectId) {
      return NextResponse.json({ success: false, error: 'Project ID required' }, { status: 400 })
    }

    const pgSchema = validated.schema || `workspace_${targetProjectId}`

    // ── Layer 1: real FK constraints in PostgreSQL (authoritative) ────────────
    const dbRels = await queryDbRelationships(pgSchema, validated.table)

    // ── Layer 2: direct column-name inference (graph-independent) ─────────────
    // This catches FK columns that exist but lack actual FOREIGN KEY constraints
    // (e.g., when the referenced table didn't exist at creation time).
    const inferred = await inferRelationshipsFromColumns(pgSchema, validated.table)

    // Merge: real FKs take priority, inferred fills the gaps
    const realKeys = new Set(dbRels.map(r => `${r.from.table}.${r.from.column}->${r.to.table}.${r.to.column}`))
    const merged = [
      ...dbRels,
      ...inferred.filter(r => {
        const key = `${r.from.table}.${r.from.column}->${r.to.table}.${r.to.column}`
        return !realKeys.has(key)
      }),
    ]

    // Best-effort: persist inferred relationships to graph + try to add real FK constraints.
    // Fire-and-forget — never blocks the response.
    if (inferred.length > dbRels.length) {
      import('@/lib/ai/minimal-executor')
        .then(m => m.inferAndSaveRelationships(targetProjectId))
        .catch(() => { /* non-fatal */ })
    }

    const source = dbRels.length > 0 && inferred.length > dbRels.length ? 'merged'
                 : dbRels.length > 0 ? 'database'
                 : inferred.length > 0 ? 'inferred'
                 : 'none'

    return NextResponse.json({ success: true, data: merged, source })
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: 'Validation error', details: error.errors },
        { status: 400 }
      )
    }
    console.error('Error fetching relationships:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to fetch relationships', message: error.message },
      { status: 500 }
    )
  }
})

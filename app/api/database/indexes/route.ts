export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { workspaceRawClient } from '@/lib/data-plane/regional'
import { regionErrorResponse } from '@/lib/api/v1/errors'
import { isProjectOwnedSchema } from '@/lib/security/workspace-schema'
import { z } from 'zod'

const querySchema = z.object({
  schema: z.string(),
  table: z.string(),
  projectId: z.string().optional(),
})

/**
 * GET /api/database/indexes - Get table indexes (PostgreSQL only)
 * 🔒 Protected: Requires authentication and project access
 */
export const GET = withProjectAccess(async (request: NextRequest, { projectId }) => {
  try {
    const searchParams = request.nextUrl.searchParams
    const validated = querySchema.parse({
      schema: searchParams.get('schema'),
      table: searchParams.get('table'),
      projectId: searchParams.get('projectId') || undefined,
    })

    // Access to `projectId` is verified; the schema must be one of that
    // project's own (its schema or a branch's). A schema named by the caller is
    // otherwise any schema in the database, another tenant's included.
    if (!isProjectOwnedSchema(projectId, validated.schema)) {
      return NextResponse.json(
        { success: false, error: 'That schema is not part of this project.', code: 'SCHEMA_NOT_IN_PROJECT' },
        { status: 403 },
      )
    }

    // The catalog of the database holding the project's data, in its region.
    const db = await workspaceRawClient(projectId)
    const result = await db.$queryRaw<Array<{
      indexname: string
      indexdef: string
      tablename: string
    }>>`
      SELECT
        i.relname as indexname,
        pg_get_indexdef(i.oid) as indexdef,
        t.relname as tablename
      FROM pg_class t
      JOIN pg_index ix ON t.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = ${validated.schema}
        AND t.relname = ${validated.table}
        AND t.relkind = 'r'
      ORDER BY i.relname
    `

    const indexes = result.map((r) => {
      const isUnique = r.indexdef.includes('UNIQUE')
      const columnsMatch = r.indexdef.match(/\(([^)]+)\)/)
      const columns = columnsMatch ? columnsMatch[1].split(',').map(c => c.trim().replace(/"/g, '')) : []

      return {
        name: r.indexname,
        columns,
        unique: isUnique,
        type: isUnique ? 'UNIQUE' : 'BTREE',
      }
    })

    return NextResponse.json({
      success: true,
      data: indexes,
    })
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          success: false,
          error: 'Validation error',
          details: error.errors,
        },
        { status: 400 }
      )
    }

    const regional = regionErrorResponse(error)
    if (regional) return regional

    console.error('Error fetching indexes:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch indexes',
        message: error.message,
      },
      { status: 500 }
    )
  }
});


export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { PostgresService } from '@/lib/db/hybrid'
import { prisma } from '@/lib/db'
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
export const GET = withProjectAccess(async (request: NextRequest, { user, project, projectId }) => {
  try {
    const searchParams = request.nextUrl.searchParams
    const validated = querySchema.parse({
      schema: searchParams.get('schema'),
      table: searchParams.get('table'),
      projectId: searchParams.get('projectId') || undefined,
    })

    // At this point, project access is already verified by withProjectAccess middleware
    // Check if this is a workspace schema
    const isWorkspaceSchema = validated.schema?.startsWith('workspace_')
    
    // If workspace schema, the project ownership is already verified
    
    let indexes
    
    if (isWorkspaceSchema && validated.projectId) {
      // Use default Prisma client - pg_catalog is accessible from any connection
      const result = await prisma.$queryRaw<Array<{
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
      
      indexes = result.map((r) => {
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
    } else {
      // Use default Prisma client for platform schemas
      indexes = await PostgresService.getTableIndexes(validated.schema, validated.table)
    }

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


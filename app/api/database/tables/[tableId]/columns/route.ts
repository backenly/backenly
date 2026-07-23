export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAuth } from '@/lib/auth/middleware'

/**
 * GET /api/database/tables/[tableId]/columns
 *
 * Fetch table column information for API Tester.
 * 🔒 Requires auth + project ownership. Previously this endpoint had no
 * ownership check — any authed user could read any project's table schema.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { tableId: string } }
) {
  try {
    const user = await requireAuth(request)
    const { searchParams } = new URL(request.url)
    const projectId = searchParams.get('projectId')

    if (!projectId) {
      return NextResponse.json(
        { error: 'projectId is required' },
        { status: 400 }
      )
    }

    // Ownership check before any data is returned.
    const owned = await prisma.project.findFirst({
      where: { id: projectId, userId: user.userId },
      select: { id: true },
    })
    if (!owned) {
      return NextResponse.json({ error: 'Project not found or access denied' }, { status: 403 })
    }

    // Get table info
    const table = await prisma.table.findFirst({
      where: {
        id: params.tableId,
        projectId,
      },
    })
    
    if (!table) {
      return NextResponse.json(
        { error: 'Table not found' },
        { status: 404 }
      )
    }
    
    // Fetch column information from PostgreSQL
    const columns = await prisma.$queryRawUnsafe<Array<{
      column_name: string
      data_type: string
      is_nullable: string
      column_default: string | null
    }>>(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
    `, table.schema, table.name)
    
    // Format for frontend
    const formattedColumns = columns.map(col => ({
      name: col.column_name,
      type: col.data_type,
      nullable: col.is_nullable === 'YES',
      default: col.column_default,
    }))
    
    return NextResponse.json({
      success: true,
      columns: formattedColumns,
      table: {
        name: table.name,
        schema: table.schema,
      },
    })
  } catch (error: any) {
    console.error('[Table Columns API] Error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to fetch columns' },
      { status: 500 }
    )
  }
}

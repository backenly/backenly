export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { z } from 'zod'
import { resolveTableStructure } from '@/lib/services/workspace-schema-resolver'

const querySchema = z.object({
  type: z.enum(['postgresql', 'mongodb']),
  schema: z.string().optional(),
  table: z.string(),
  projectId: z.string().optional(),
  view: z.enum(['platform', 'workspace', 'all']).optional(),
})

/**
 * GET /api/database/structure - Get the column structure of one table.
 *
 * Reads the reconciliation kernel in lib/services/workspace-schema-resolver.ts.
 * Live introspection of `workspace_{projectId}.{table}` is ground truth; graph
 * field metadata is layered on top. A `planned` table (graph intent not yet
 * materialised) falls back to its declared graph fields.
 *
 * 404 is returned ONLY when the table exists in neither the database nor the
 * graph — the previous "not found in graph" 404 fired even for tables that
 * physically existed, which is the bug this route used to have.
 */
export const GET = withProjectAccess(async (request: NextRequest, { user, project, projectId }) => {
  const searchParams = request.nextUrl.searchParams

  try {
    const validated = querySchema.parse({
      type: searchParams.get('type') || 'postgresql',
      schema: searchParams.get('schema') || undefined,
      table: searchParams.get('table'),
      projectId: searchParams.get('projectId') || undefined,
      view: searchParams.get('view') || 'workspace',
    })

    const targetProjectId = validated.projectId || projectId

    if (!targetProjectId) {
      return NextResponse.json({
        success: false,
        error: 'Project ID required',
      }, { status: 400 })
    }

    const columns = await resolveTableStructure(targetProjectId, validated.table)

    if (columns === null) {
      return NextResponse.json(
        {
          success: false,
          error: `Table '${validated.table}' does not exist in this project`,
        },
        { status: 404 }
      )
    }

    return NextResponse.json({
      success: true,
      data: columns,
      source: 'reconciled',
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

    console.error('[Structure API] Error fetching structure:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch structure',
        message: error.message || 'Unknown error occurred',
      },
      { status: 500 }
    )
  }
})

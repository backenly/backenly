export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { z } from 'zod'
import {
  resolveWorkspaceTables,
  reconcileGraphDrift,
} from '@/lib/services/workspace-schema-resolver'

const querySchema = z.object({
  type: z.enum(['postgresql', 'mongodb']),
  schema: z.string().optional(),
  projectId: z.string().optional(),
  view: z.enum(['platform', 'workspace', 'all']).optional(),
})

/**
 * GET /api/database/tables - List tables for a project's workspace.
 *
 * Reads the reconciliation kernel in lib/services/workspace-schema-resolver.ts:
 * the live workspace schema is ground truth for existence, the BackendGraph
 * supplies intent + metadata. The two are unioned deterministically — no more
 * "graph says one thing, database says another" divergence between this route
 * and /api/database/structure.
 */
export const GET = withProjectAccess(async (request: NextRequest, { user, project, projectId }) => {
  const requestId = Math.random().toString(36).substring(7)
  console.log(`[${requestId}] 🔍 GET /api/database/tables - reconciled request`)

  try {
    const searchParams = request.nextUrl.searchParams
    const validated = querySchema.parse({
      type: searchParams.get('type') || 'postgresql',
      schema: searchParams.get('schema') || undefined,
      projectId: searchParams.get('projectId') || undefined,
      view: searchParams.get('view') || 'all',
    })

    const targetProjectId = validated.projectId || projectId

    if (!targetProjectId) {
      return NextResponse.json({
        success: false,
        error: 'Project ID required',
      }, { status: 400 })
    }

    const { tables, driftDetected } = await resolveWorkspaceTables(targetProjectId)

    // Self-heal: when the live schema has tables/columns the graph is missing,
    // backfill the graph in the background. The response above is ALREADY
    // correct — reconciliation is graph hygiene only, so we never await it.
    if (driftDetected) {
      reconcileGraphDrift(targetProjectId).catch(() => {})
    }

    console.log(`[${requestId}] ✅ Returning ${tables.length} reconciled tables (drift=${driftDetected})`)
    return NextResponse.json({
      success: true,
      data: tables.map((t) => ({
        name: t.name,
        schema: t.schema,
        rows: t.rows,
        size: t.size,
        fieldCount: t.fieldCount,
        status: t.status,
        createdAt: t.createdAt,
        createdBy: t.createdBy,
      })),
      count: tables.length,
      view: validated.view,
      projectId: targetProjectId,
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

    console.error(`[${requestId}] ❌ Error fetching tables:`, error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch tables',
        message: error.message,
      },
      { status: 500 }
    )
  }
})

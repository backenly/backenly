export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { prisma } from '@/lib/db'
import { getWorkspaceDatabaseNames } from '@/lib/services/databaseProvisioning'
import { workspaceRawClient } from '@/lib/data-plane/regional'
import { regionErrorResponse } from '@/lib/api/v1/errors'
import { isProjectOwnedSchema, projectSchemaPrefix, workspaceSchemaName } from '@/lib/security/workspace-schema'

/**
 * GET /api/database/schemas - The project's own PostgreSQL schemas
 * Query params:
 *   - projectId: required; access to it is verified
 *   - view: 'workspace' (the project's schema) | 'all' (the project's schema and
 *     its branches' schemas) | 'platform' (refused) — default 'all'
 *
 * A project's schemas are the only ones a caller may list. Every other schema
 * in the database is another tenant's (whose name carries its project id) or
 * the platform's own, and neither is any one project's to read.
 * 🔒 Protected: Requires authentication and project access
 */
export const GET = withProjectAccess(async (request: NextRequest, { projectId }) => {
  try {
    const view = request.nextUrl.searchParams.get('view') || 'all'

    if (view === 'platform') {
      return NextResponse.json(
        { success: false, error: "The platform's own schemas are not listed.", code: 'PLATFORM_SCHEMAS_NOT_LISTED' },
        { status: 403 },
      )
    }
    if (view !== 'workspace' && view !== 'all') {
      return NextResponse.json({ success: false, error: 'view is workspace or all' }, { status: 400 })
    }

    // The project's own schema: as provisioned, or the name it will have.
    const workspace = await prisma.workspace.findFirst({
      where: { projectId },
      select: { postgresSchema: true, databaseProvisioned: true },
    })
    const ownSchema =
      workspace?.databaseProvisioned && workspace.postgresSchema && isProjectOwnedSchema(projectId, workspace.postgresSchema)
        ? workspace.postgresSchema
        : getWorkspaceDatabaseNames(projectId).postgresSchema

    let schemas: string[]
    if (view === 'workspace') {
      schemas = [ownSchema]
    } else {
      // The project's schema and its branches', from the database holding its
      // data (its region), never the whole catalog.
      const canonical = workspaceSchemaName(projectId)
      const prefix = projectSchemaPrefix(projectId)
      const db = await workspaceRawClient(projectId)
      const rows = await db.$queryRaw<Array<{ schema_name: string }>>`
        SELECT schema_name
          FROM information_schema.schemata
         WHERE schema_name::text = ${canonical} OR starts_with(schema_name::text, ${prefix})
         ORDER BY schema_name
      `
      schemas = rows.map((r) => r.schema_name).filter((s) => isProjectOwnedSchema(projectId, s))
      if (!schemas.includes(ownSchema)) schemas.unshift(ownSchema)
    }

    return NextResponse.json({
      success: true,
      data: schemas,
      view,
      projectId,
    })
  } catch (error: any) {
    const regional = regionErrorResponse(error)
    if (regional) return regional

    console.error('Error fetching schemas:', { message: error?.message, code: error?.code })
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch schemas',
        message: error.message,
      },
      { status: 500 }
    )
  }
});

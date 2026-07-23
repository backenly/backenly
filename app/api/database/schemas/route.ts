export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { prisma } from '@/lib/db'
import { getWorkspaceDatabaseNames } from '@/lib/services/databaseProvisioning'
import { PostgresService } from '@/lib/db/hybrid'

/**
 * GET /api/database/schemas - List all PostgreSQL schemas
 * Query params:
 *   - projectId: Optional - if provided, shows workspace schema for that project
 *   - view: 'platform' | 'workspace' | 'all' (default: 'all')
 * 🔒 Protected: Requires authentication and project access
 */
export const GET = withProjectAccess(async (request: NextRequest, { user, project, projectId }) => {
  const requestId = Math.random().toString(36).substring(7);
  console.log(`[${requestId}] 🔍 GET /api/database/schemas - Request received`);
  console.log(`[${requestId}] 📋 User:`, { userId: user?.userId, email: user?.email });
  console.log(`[${requestId}] 📋 Project:`, { projectId, projectName: project?.name });
  
  try {
    const searchParams = request.nextUrl.searchParams
    const view = searchParams.get('view') || 'all'
    console.log(`[${requestId}] 📋 Query params:`, { view, projectId });

    // At this point, project access is already verified by withProjectAccess middleware
    // The project variable contains the verified project

    let schemas: string[] = []

    if (view === 'platform' || view === 'all') {
      console.log(`[${requestId}] 🔄 Fetching all schemas from PostgresService...`);
      // Get all schemas (includes platform + workspace schemas)
      const allSchemas = await PostgresService.listSchemas()
      console.log(`[${requestId}] ✅ Retrieved ${allSchemas.length} schemas:`, allSchemas);
      
      if (view === 'platform') {
        // Filter to only platform schemas (public and backenly_*)
        schemas = allSchemas.filter(s => 
          s === 'public' || 
          s.startsWith('backenly_') ||
          !s.startsWith('workspace_')
        )
        console.log(`[${requestId}] 🔍 Filtered to ${schemas.length} platform schemas:`, schemas);
      } else {
        schemas = allSchemas
      }
    }

    // If projectId is provided, also include/prioritize workspace schema
    if (projectId) {
      console.log(`[${requestId}] 🔄 Looking up workspace for projectId:`, projectId);
      const workspace = await prisma.workspace.findFirst({
        where: { projectId },
        select: {
          postgresSchema: true,
          databaseProvisioned: true,
        },
      })
      console.log(`[${requestId}] 📊 Workspace found:`, workspace);

      if (workspace?.databaseProvisioned && workspace.postgresSchema) {
        console.log(`[${requestId}] ✅ Workspace is provisioned with schema:`, workspace.postgresSchema);
        // Ensure workspace schema is in the list
        if (!schemas.includes(workspace.postgresSchema)) {
          schemas.push(workspace.postgresSchema)
          console.log(`[${requestId}] ➕ Added workspace schema to list`);
        }
        // If view is 'workspace', only return workspace schema
        if (view === 'workspace') {
          schemas = [workspace.postgresSchema]
          console.log(`[${requestId}] 🔍 Filtered to workspace schema only:`, schemas);
        }
      } else {
        console.log(`[${requestId}] ⚠️ Workspace not provisioned or schema missing`);
        // Workspace not provisioned yet, generate expected schema name
        const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
        console.log(`[${requestId}] 🔄 Generated expected schema name:`, postgresSchema);
        if (view === 'workspace') {
          schemas = [postgresSchema]
          console.log(`[${requestId}] 📋 Using expected schema for workspace view:`, schemas);
        }
      }
    } else if (view === 'workspace') {
      console.log(`[${requestId}] 🔄 No projectId provided, fetching all workspace schemas`);
      // No projectId but view is workspace - return empty or all workspace schemas
      const allSchemas = await PostgresService.listSchemas()
      schemas = allSchemas.filter(s => s.startsWith('workspace_'))
      console.log(`[${requestId}] 📋 Found ${schemas.length} workspace schemas:`, schemas);
    }

    console.log(`[${requestId}] ✅ Final schemas to return:`, { count: schemas.length, schemas, view, projectId });
    return NextResponse.json({
      success: true,
      data: schemas,
      view,
      projectId: projectId || null,
    })
  } catch (error: any) {
    console.error(`[${requestId}] ❌ Error fetching schemas:`, {
      message: error.message,
      stack: error.stack,
      name: error.name,
      code: error.code,
    });
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch schemas',
        message: error.message,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      },
      { status: 500 }
    )
  }
});


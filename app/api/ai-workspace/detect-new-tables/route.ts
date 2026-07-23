export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/middleware'
import { getCurrentProjectId } from '@/lib/tenant/isolation'
import { prisma } from '@/lib/db'

/**
 * Detect New Tables Without APIs
 * 
 * This endpoint detects tables created in Database Management
 * that don't have corresponding API routes yet.
 * 
 * POST /api/ai-workspace/detect-new-tables
 */
export async function POST(request: NextRequest) {
  const requestId = `detect-${Date.now()}`
  console.log(`🔵 [${requestId}] === DETECT NEW TABLES REQUEST START ===`)

  try {
    // Authenticate user
    console.log(`🔐 [${requestId}] Authenticating request...`)
    const user = await requireAuth(request)
    console.log(`✅ [${requestId}] User authenticated: ${user.userId}`)

    // Get current project ID
    console.log(`🎯 [${requestId}] Getting current project ID...`)
    const projectId = await getCurrentProjectId(request)
    
    if (!projectId) {
      console.error(`❌ [${requestId}] No project selected`)
      return NextResponse.json(
        { success: false, error: 'No project selected' },
        { status: 400 }
      )
    }

    console.log(`✅ [${requestId}] Project ID: ${projectId}`)

    // Get all tables from database (with their IDs)
    console.log(`📊 [${requestId}] Fetching tables from database...`)
    const tables = await prisma.table.findMany({
      where: { projectId },
      select: { id: true, name: true, description: true, createdAt: true },
    })

    console.log(`📊 [${requestId}] Found ${tables.length} tables in database`)

    // Get workspace to check for existing routes
    const workspace = await prisma.workspace.findFirst({
      where: { projectId },
      select: { id: true },
    })

    if (!workspace) {
      console.warn(`⚠️ [${requestId}] No workspace found for project`)
      return NextResponse.json({
        success: true,
        data: {
          newTables: [],
          message: 'No workspace found. Create a workspace first.',
        },
      })
    }

    // Check which tables have API Definitions
    console.log(`🔍 [${requestId}] Checking for API Definitions...`)
    
    const apiDefinitions = await prisma.apiDefinition.findMany({
      where: { projectId },
      select: { name: true, tableId: true },
    })

    // Build a set of table IDs that have API Definitions
    const tableIdsWithApis = new Set(apiDefinitions.map(api => api.tableId))
    
    console.log(`📊 [${requestId}] Found ${apiDefinitions.length} API Definitions`)
    console.log(`🔍 [${requestId}] API names:`, apiDefinitions.map(a => a.name))

    // Find tables without API Definitions
    const newTables = tables.filter(table => {
      const hasApi = tableIdsWithApis.has(table.id)
      console.log(`  - ${table.name}: ${hasApi ? 'HAS API' : 'NO API'}`)
      return !hasApi
    })

    console.log(`✨ [${requestId}] Found ${newTables.length} tables without APIs`)

    // Return tables that need API generation
    console.log(`🟢 [${requestId}] === DETECT NEW TABLES REQUEST COMPLETE ===`)

    return NextResponse.json({
      success: true,
      data: {
        newTables: newTables.map(table => ({
          name: table.name,
          description: table.description,
          createdAt: table.createdAt,
          suggestedPrompt: `Create a complete CRUD API for the ${table.name} table with GET (list with pagination/filtering/search), GET by ID, POST (create), PUT (update), and DELETE endpoints. Include proper validation, error handling, and authentication middleware.`,
        })),
        totalTables: tables.length,
        tablesWithAPIs: tables.length - newTables.length,
      },
    })
  } catch (error: any) {
    console.error(`🔴 [${requestId}] === DETECT NEW TABLES REQUEST FAILED ===`)
    console.error(`❌ [${requestId}] Error Type: ${error.constructor.name}`)
    console.error(`❌ [${requestId}] Error Message: ${error.message}`)
    console.error(`❌ [${requestId}] Stack:`, error.stack?.split('\n').slice(0, 10).join('\n'))

    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Failed to detect new tables',
        ...(process.env.NODE_ENV === 'development' && {
          details: {
            type: error.constructor.name,
            message: error.message,
            stack: error.stack?.split('\n').slice(0, 5),
          },
        }),
      },
      { status: 500 }
    )
  }
}

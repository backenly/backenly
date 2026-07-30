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
    
    // Which tables are actually reachable over REST, from the catalog.
    //
    // This read ApiDefinition, which has had no create path since the PostgREST
    // cutover. On every project built after it the set was empty, so EVERY
    // table came back as "needs an API" - and NewTablesSuggestionWidget
    // auto-expands on a non-empty result and offers a "Generate API" button per
    // table. Every modern project was permanently prompted to generate APIs for
    // tables already serving traffic, behind a button whose executor cannot
    // change the condition.
    //
    // A table that IS exposed needs nothing. One that is not is worth
    // surfacing, which is what this widget is for.
    const { listExposedResources } = await import('@/lib/api/exposed-resources')
    const exposed = await listExposedResources(projectId)
    const exposedNames = new Set(exposed.map(r => r.name.toLowerCase()))

    const newTables = tables.filter(t => !exposedNames.has(t.name.toLowerCase()))

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
          suggestedPrompt: `Make the ${table.name} table reachable over the REST API - check that its schema is registered with PostgREST and that the API role holds a grant on it.`,
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

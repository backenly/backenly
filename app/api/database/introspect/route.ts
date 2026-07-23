export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { PostgresService } from '@/lib/db/hybrid'
import { loadGraph } from '@/lib/orchestration/backend-state-graph'

/**
 * GET /api/database/introspect - Compare graph vs reality
 * 
 * Returns:
 * - What the graph THINKS exists
 * - What ACTUALLY exists in the database
 * - The gap (what's fake vs real)
 * 
 * 🚨 This is the TRUTH endpoint - it never lies
 */
export const GET = withProjectAccess(async (request: NextRequest, { user, project, projectId }) => {
  try {
    console.log('[Introspect] Starting introspection for project:', projectId)
    
    // Step 1: Load graph (what we THINK exists)
    const graph = await loadGraph(projectId)
    const graphTables = Object.keys(graph.entities)
    
    console.log('[Introspect] Graph says these tables exist:', graphTables)
    
    // Step 2: Query real database (what ACTUALLY exists)
    const schemaName = `workspace_${projectId}`
    let realTables: string[] = []
    let schemaExists = false
    
    try {
      const schemas = await PostgresService.listSchemas()
      schemaExists = schemas.includes(schemaName)
      
      if (schemaExists) {
        const tables = await PostgresService.listTables(schemaName)
        realTables = tables.map(t => t.name)
        console.log('[Introspect] Database says these tables exist:', realTables)
      } else {
        console.log('[Introspect] Schema does not exist yet:', schemaName)
      }
    } catch (error) {
      console.error('[Introspect] Failed to query database:', error)
    }
    
    // Step 3: Compare
    const onlyInGraph = graphTables.filter(t => !realTables.includes(t))
    const onlyInDB = realTables.filter(t => !graphTables.includes(t))
    const inBoth = graphTables.filter(t => realTables.includes(t))
    
    // Step 4: Verdict
    const isReal = onlyInGraph.length === 0 && inBoth.length > 0
    const isFake = graphTables.length > 0 && realTables.length === 0
    const isMixed = onlyInGraph.length > 0 && realTables.length > 0
    
    return NextResponse.json({
      success: true,
      projectId,
      schemaName,
      schemaExists,
      truth: {
        graph: {
          tables: graphTables,
          count: graphTables.length,
        },
        database: {
          tables: realTables,
          count: realTables.length,
        },
        comparison: {
          onlyInGraph,
          onlyInDB,
          inBoth,
        },
        verdict: {
          isReal,
          isFake,
          isMixed,
          message: isReal 
            ? '✅ Graph and database are in sync - REAL execution working'
            : isFake
            ? '❌ Graph has tables but database is empty - SIMULATION ONLY'
            : isMixed
            ? '⚠️ Some tables are real, some are fake - PARTIAL execution'
            : '🆕 No tables yet - ready for first execution',
        },
      },
    })
  } catch (error: any) {
    console.error('[Introspect] Error:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to introspect database',
        message: error.message,
      },
      { status: 500 }
    )
  }
})

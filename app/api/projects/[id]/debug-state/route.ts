import { NextRequest, NextResponse } from 'next/server'
import { loadGraph } from '@/lib/orchestration/backend-state-graph'

/**
 * Debug endpoint to view the complete backend state graph
 * This shows you exactly what was created: tables, auth, storage, APIs
 */
export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const projectId = params.id

    // Load the current backend state graph
    const graph = await loadGraph(projectId)

    // Extract key information
    const tables = Object.keys(graph.entities)
    const authProviders = Object.entries(graph.auth.providers)
      .filter(([_, config]) => config.enabled)
      .map(([name, _]) => name)
    
    const storageBuckets = Object.keys(graph.storage.buckets)
    const apis = Object.keys(graph.apis)

    // Build verification summary
    const summary = {
      projectId,
      version: graph.version,
      lastUpdated: graph.lastUpdated,
      
      // Database
      database: {
        tablesCreated: tables.length,
        tables: tables,
        entities: graph.entities,
      },

      // Auth
      auth: {
        enabled: authProviders.length > 0,
        providers: authProviders,
        details: graph.auth,
      },

      // Storage
      storage: {
        enabled: storageBuckets.length > 0,
        bucketsCreated: storageBuckets.length,
        buckets: storageBuckets,
        details: graph.storage.buckets,
      },

      // APIs
      apis: {
        endpointsCreated: apis.length,
        endpoints: apis,
        details: graph.apis,
      },

      // Full graph (for debugging)
      fullGraph: graph,
    }

    return NextResponse.json(summary, { status: 200 })
  } catch (error) {
    console.error('[Debug State API] Error:', error)
    return NextResponse.json(
      { error: 'Failed to load state', details: error },
      { status: 500 }
    )
  }
}

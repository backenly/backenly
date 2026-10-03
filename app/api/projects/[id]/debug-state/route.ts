import { NextRequest, NextResponse } from 'next/server'
import { loadGraph } from '@/lib/orchestration/backend-state-graph'
import { withAuth } from '@/lib/auth/route-protection'
import { canAccessProject } from '@/lib/edition/guard'

/**
 * Debug endpoint to view the complete backend state graph
 * This shows you exactly what was created: tables, auth, storage, APIs
 */

/**
 * ── This route had NO authentication ────────────────────────────────────────
 *
 * It took a project id from the path and answered. Anyone able to reach the
 * server and name a project could read the complete backend state graph: every table, auth provider, storage bucket and API - without a session, let alone
 * ownership. Found by the route-authorization sweep; no UI called it, which is
 * why nothing ever noticed.
 *
 * A read is not harmless here: it discloses how somebody else's backend is
 * built. 404 rather than 403, so the endpoint is not an oracle for project ids.
 */
export const GET = withAuth(async (request: NextRequest, { user, params: routeParams }) => {
  const params = await routeParams
  try {
    const projectId = params.id

    if (!(await canAccessProject(user.userId, projectId))) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

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
})

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth/jwt'
import { loadGraph } from '@/lib/orchestration/backend-state-graph'
import { prisma } from '@/lib/db/prisma'
import { isProjectLive } from '@/lib/orchestration/graph-pointer'
import { getProjectAuthStatus } from '@/lib/services/auth-status'
import { isReservedWorkspaceTable } from '@/lib/security/workspace-schema'
import { canAccessProject } from '@/lib/edition/guard'

/**
 * GET /api/projects/[projectId]/state
 * 
 * Fetch backend state graph for workspace panels
 */
export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    // Authenticate
    const sessionToken = request.cookies.get('auth-token')?.value
    if (!sessionToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const decoded = await verifyToken(sessionToken)
    const userId = decoded.userId
    const projectId = params.id

    // Ownership gate — without this any authenticated user could read another
    // project's backend state (table names, APIs, capabilities) by id.
    if (!(await canAccessProject(userId, projectId))) {
      return NextResponse.json({ error: 'Project not found or access denied' }, { status: 404 })
    }

    // Check deployment status
    const isLive = await isProjectLive(projectId)

    // Load backend state graph
    const { getActiveGraph } = await import('@/lib/orchestration/graph-pointer')
    const graph = await getActiveGraph(projectId)

    // Always use prisma.table as ground truth for entities.
    // The dynamic build loop writes to prisma.table but does NOT update BackendStateGraph,
    // so reading graph.entities gives stale/partial counts. Graph is used only for field metadata.
    const [prismaTablesRaw, functionCount, triggerCount, projectRow, prismaBucketCount] = await Promise.all([
      prisma.table.findMany({
        where: { projectId },
        select: { name: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.aiFunction.count({ where: { projectId } }).catch(() => 0),
      prisma.appTrigger.count({ where: { projectId } }).catch(() => 0),
      prisma.project.findUnique({ where: { id: projectId }, select: { jwtSecret: true } }),
      // Authoritative bucket count — Prisma is ground truth, same as tables
      prisma.storageBucket.count({ where: { projectId } }).catch(() => 0),
    ])

    // Deduplicate tables by name — duplicate rows can accumulate when the build
    // loop runs multiple times (e.g. after credential submission). First occurrence wins.
    // Also filter out every reserved internal table (canonical predicate — covers
    // all leading-underscore plumbing: _backenly_*, _token_blacklist,
    // _email_verifications, _magic_links, _password_resets, _prisma_*) so they
    // never inflate the user-facing dashboard count.
    const seenTableNames = new Set<string>()
    const prismaTables = prismaTablesRaw.filter(t => {
      if (seenTableNames.has(t.name)) return false
      if (isReservedWorkspaceTable(t.name)) return false
      seenTableNames.add(t.name)
      return true
    })

    const graphEntities = graph?.entities || {}

    // Identify tables where the graph has no field-level data so we can fall back
    // to a live information_schema query. The build runtime writes to prisma.table
    // immediately but only populates graph.entities.fields after schema generation
    // completes — so newly-built tables show 0 fields until the graph is updated.
    const tableNames = prismaTables.map(t => t.name)
    const emptyGraphTables = prismaTables
      .filter(t => !graphEntities[t.name] || Object.keys(graphEntities[t.name]?.fields || {}).length === 0)
      .map(t => t.name)

    // Fetch live column counts from workspace schema for tables with no graph field data
    let liveColumnCounts: Record<string, number> = {}
    if (emptyGraphTables.length > 0) {
      try {
        const workspaceSchema = `workspace_${params.id}`
        const placeholders = tableNames.map((_, i) => `$${i + 2}`).join(', ')
        const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string; col_count: string }>>(
          `SELECT table_name, COUNT(*) AS col_count
           FROM information_schema.columns
           WHERE table_schema = $1 AND table_name IN (${placeholders})
           GROUP BY table_name`,
          workspaceSchema,
          ...tableNames
        )
        for (const row of rows) {
          liveColumnCounts[row.table_name] = parseInt(row.col_count, 10)
        }
      } catch {
        // Non-fatal — fieldCount will remain 0 for tables without graph data
      }
    }

    const entities: Array<{ name: string; fieldCount: number; fields: Array<{ name: string; type: string }> }> =
      prismaTables.map(t => {
        const graphEntity = graphEntities[t.name]
        const graphFieldCount = graphEntity ? Object.keys(graphEntity.fields || {}).length : 0
        // Use graph field count when available; fall back to live workspace column count
        const fieldCount = graphFieldCount > 0 ? graphFieldCount : (liveColumnCounts[t.name] ?? 0)
        return {
          name: t.name,
          fieldCount,
          fields: graphEntity
            ? Object.keys(graphEntity.fields || {}).map(fieldName => ({
                name: fieldName,
                type: (graphEntity.fields[fieldName] as any)?.type || 'string',
              }))
            : [],
        }
      })

    // If still nothing, return empty
    if (!graph && entities.length === 0) {
      return NextResponse.json({
        entities: [],
        apis: [],
        capabilities: [],
        hasContent: false,
      })
    }

    // Genuine auth enablement — resolved once, up front, so the synthesized
    // /auth route, the endpoint count, and hasContent all agree. "Enabled" means
    // the agent actually wired auth (graph provider) or a real signup/OAuth
    // config exists — NOT the bare jwtSecret, which is seeded at creation and
    // would otherwise make every never-built project look like it has auth.
    const authStatus = await getProjectAuthStatus(projectId)
    const authEnabled = authStatus.status !== 'none'

    const { listExposedResources } = await import('@/lib/api/exposed-resources')
    const exposedResources = await listExposedResources(projectId)

    // Extract APIs — prefer graph (has per-path method info), fall back to prisma.apiDefinition.
    // The dynamic build loop writes to prisma.apiDefinition but not to graph.apis.
    let apis: Array<{ method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'; path: string; description?: string }>
    const graphApiEntries = Object.entries(graph?.apis || {})
    if (graphApiEntries.length > 0) {
      apis = graphApiEntries.map(([path, api]) => {
        const method = (api.methods[0] || 'GET').toUpperCase() as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
        return { method, path, description: api.reason }
      })
    } else {
      // Fallback: the CATALOG, which is what decides reachability.
      //
      // The comment this replaces said "prisma.apiDefinition is populated by the
      // dynamic build loop". It is not, and has not been since the PostgREST
      // cutover - there is no create path. So on any project whose graph has no
      // `apis` entries (which is every agent-built backend, since the MCP path
      // does not write graph.apis) this fallback produced an empty list and the
      // dashboard reported zero APIs.
      const seenApiPaths = new Set<string>(exposedResources.map(r => r.basePath))
      apis = exposedResources.map(r => ({
        method: 'GET' as const,
        path: r.basePath,
        description: `REST resource: ${r.name}`,
      }))

      // Include the Auth API group and Business Logic API group in the count so
      // the dashboard "APIS" number matches the inspector's view.
      // Auth group = signup/signin/refresh/logout/forgot-password/reset-password —
      // surfaced only once auth is genuinely enabled (not from the bare jwtSecret).
      // Business Logic group = domain functions registered as aiFunction records.
      if (authEnabled && !seenApiPaths.has('/auth')) {
        apis.push({ method: 'POST', path: '/auth', description: 'Auth API (signup, signin, refresh, logout, forgot-password, reset-password)' })
      }
      if (functionCount > 0 && !seenApiPaths.has('/fn')) {
        apis.push({ method: 'POST', path: '/fn', description: `Business Logic API (${functionCount} domain functions)` })
      }
    }

    // Compute total individual HTTP method+path combos across all API definitions.
    // This is what the API Builder page counts (164), as opposed to `apis.length`
    // which counts resource groups (23). We return both so every page can display
    // the correct number with a clear label.
    // 5 methods per exposed resource - list, get, create, update, delete - the
    // set the /db/* route registers. This summed a stored `endpoints` array
    // that is never written, over a list that is always empty, so endpointCount
    // was auth + functions and nothing else on every modern project.
    let endpointCount = exposedResources.length * 5
    // Built-in auth routes count only once auth is genuinely enabled
    if (authEnabled) endpointCount += 6 // signup, signin, refresh-token, logout, forgot-password, reset-password
    // AI functions each expose 1 callable route
    endpointCount += functionCount

    // Extract capabilities (dynamic based on what's enabled)
    const capabilities = []

    // Auth: resolved above (authStatus) via the shared status helper so the
    // dashboard, the auth inspector, /status, and /scan proof always agree on
    // which providers are connected. Surfaced as a capability only when genuinely
    // enabled — a bare jwtSecret no longer counts as "auth is on".
    if (authStatus.status !== 'none') {
      const enabledCount = authStatus.providers.filter(p => p.enabled).length
      capabilities.push({
        name: 'Authentication',
        enabled: true,
        icon: 'auth' as const,
        count: enabledCount,
        jwtEnabled: authStatus.jwtEnabled,
        emailPasswordEnabled: authStatus.emailPasswordEnabled,
        oauthProviders: authStatus.oauthProviders,
        status: authStatus.status,
      })
    }

    // Use Prisma storageBucket count as ground truth (same approach as tables).
    // Graph.storage.buckets can lag if the graph update was best-effort; Prisma is always accurate.
    const bucketCount = prismaBucketCount
    if (bucketCount > 0) {
      capabilities.push({
        name: 'File Storage',
        enabled: true,
        icon: 'storage' as const,
        count: bucketCount,
      })
    }

    if (graph?.realtime?.enabled) {
      capabilities.push({
        name: 'Realtime',
        enabled: true,
        icon: 'realtime' as const,
      })
    }

    const jobCount = Object.keys(graph?.jobs || {}).length
    if (jobCount > 0) {
      capabilities.push({
        name: 'Background Jobs',
        enabled: true,
        icon: 'jobs' as const,
        count: jobCount,
      })
    }

    const webhookCount = Object.keys(graph?.webhooks || {}).length
    if (webhookCount > 0) {
      capabilities.push({
        name: 'Webhooks',
        enabled: true,
        icon: 'webhooks' as const,
        count: webhookCount,
      })
    }

    const integrationCount = Object.keys(graph?.integrations || {}).length
    if (integrationCount > 0) {
      capabilities.push({
        name: 'Integrations',
        enabled: true,
        icon: 'integrations' as const,
        count: integrationCount,
      })
    }

    // Include functions and triggers in the response for the dashboard summary
    if (functionCount > 0) {
      capabilities.push({
        name: 'Functions',
        enabled: true,
        icon: 'functions' as const,
        count: functionCount,
      })
    }
    if (triggerCount > 0) {
      capabilities.push({
        name: 'Triggers',
        enabled: true,
        icon: 'triggers' as const,
        count: triggerCount,
      })
    }

    // hasContent = "the agent/user genuinely built a backend", the gate every
    // surface reads to decide between the populated dashboard and the honest
    // "connect your agent" empty state. It must NOT flip true from the built-in
    // scaffolding a freshly-named project ships with (the `users` auth table and
    // the jwtSecret-derived /auth route). Backenly is agent-native now: nothing
    // reads as "built" until real content exists — a real (non-`users`) table, a
    // generated API, a function, a bucket, realtime/jobs/webhooks/integrations,
    // or genuinely-enabled auth.
    const realTables = entities.filter(e => e.name.toLowerCase() !== 'users')
    const hasContent =
      realTables.length > 0 ||
      exposedResources.length > 0 ||
      authEnabled ||
      functionCount > 0 ||
      bucketCount > 0 ||
      (graph?.realtime?.enabled ?? false) ||
      jobCount > 0 ||
      webhookCount > 0 ||
      integrationCount > 0

    return NextResponse.json({
      entities,
      apis,
      endpointCount,     // Total individual HTTP method+path combos (matches API Builder count)
      capabilities,
      hasContent,
      isLive,
    })
  } catch (error) {
    console.error('[State API] Error:', error)
    return NextResponse.json(
      { error: 'Failed to load backend state' },
      { status: 500 }
    )
  }
}

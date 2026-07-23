/**
 * PHASE 4: Orchestration Integration - Sandbox Snapshot Preparation
 * 
 * Packages BackendStateGraph into optimized snapshot for instant sandbox launch.
 * Called after build execution completes.
 */

import { BackendStateGraph } from '@/lib/orchestration/backend-state-graph'
import { prisma } from '@/lib/db'

export interface SandboxSnapshot {
  projectId: string
  version: number
  preparedAt: Date
  entities: Array<{
    name: string
    fields: Record<string, { name: string; type: string; nullable: boolean }>
    relationships: any[]
  }>
  auth: {
    enabled: boolean
    providers: string[]
  }
  storage: {
    enabled: boolean
    buckets: string[]
  }
  apis: Array<{
    method: string
    path: string
    entity: string
  }>
  optimized: boolean
}

/**
 * Prepare sandbox snapshot from BackendStateGraph
 * 
 * This is called after orchestration completes to package the graph
 * into an optimized format for instant sandbox runtime startup.
 * 
 * @param graph - Backend state graph to snapshot
 * @returns Optimized sandbox snapshot
 */
export async function prepareSandboxSnapshot(
  graph: BackendStateGraph
): Promise<SandboxSnapshot> {
  console.log(`[Sandbox Snapshot] Preparing snapshot for project: ${graph.projectId}`)

  // Extract entities with minimal fields needed for runtime
  const entities = Object.entries(graph.entities).map(([name, entity]) => ({
    name: name,
    fields: Object.entries(entity.fields).reduce((acc, [fieldName, field]) => {
      acc[fieldName] = {
        name: field.name,
        type: field.type,
        nullable: field.nullable,
      }
      return acc
    }, {} as Record<string, { name: string; type: string; nullable: boolean }>),
    relationships: entity.relationships || [],
  }))

  // Extract auth config  
  const authProviders = Object.keys(graph.auth?.providers || {}).filter(
    (p) => graph.auth.providers[p as keyof typeof graph.auth.providers]?.enabled
  )
  const auth = {
    enabled: authProviders.length > 0,
    providers: authProviders,
  }

  // Extract storage config
  const storage = {
    enabled: Object.keys(graph.storage?.buckets || {}).length > 0,
    buckets: Object.keys(graph.storage?.buckets || {}),
  }

  // Generate API routes from entities and graph.apis
  const apis: Array<{ method: string; path: string; entity: string }> = []
  
  // Add CRUD routes for each entity
  for (const [entityName, entity] of Object.entries(graph.entities)) {
    const basePath = `/api/${entityName.toLowerCase()}`
    apis.push(
      { method: 'GET', path: basePath, entity: entityName },
      { method: 'GET', path: `${basePath}/:id`, entity: entityName },
      { method: 'POST', path: basePath, entity: entityName },
      { method: 'PUT', path: `${basePath}/:id`, entity: entityName },
      { method: 'DELETE', path: `${basePath}/:id`, entity: entityName }
    )
  }

  // Add custom APIs from graph
  for (const [apiId, api] of Object.entries(graph.apis)) {
    // Use first method if multiple methods defined
    const method = Array.isArray(api.methods) && api.methods.length > 0 ? api.methods[0] : 'GET'
    apis.push({
      method,
      path: api.path,
      entity: 'custom',
    })
  }

  const snapshot: SandboxSnapshot = {
    projectId: graph.projectId,
    version: graph.version,
    preparedAt: new Date(),
    entities,
    auth,
    storage,
    apis,
    optimized: true,
  }

  // Persist snapshot to database for quick retrieval
  try {
    await prisma.projectMetadata.update({
      where: { projectId: graph.projectId },
      data: {
        backendStateGraph: {
          ...graph,
          _sandboxSnapshot: snapshot as any, // Store in nested property
        } as any,
      },
    })
    console.log(`[Sandbox Snapshot] ✅ Snapshot saved for project: ${graph.projectId}`)
  } catch (error) {
    console.error(`[Sandbox Snapshot] Failed to save snapshot:`, error)
    // Don't throw - snapshot will be regenerated on-demand if needed
  }

  return snapshot
}

/**
 * Load sandbox snapshot from database
 * 
 * @param projectId - Project ID to load snapshot for
 * @returns Sandbox snapshot or null if not found
 */
export async function loadSandboxSnapshot(
  projectId: string
): Promise<SandboxSnapshot | null> {
  try {
    const metadata = await prisma.projectMetadata.findUnique({
      where: { projectId },
      select: { backendStateGraph: true },
    })

    // @ts-ignore - Extract snapshot from nested graph property
    if (metadata?.backendStateGraph?._sandboxSnapshot) {
      console.log(`[Sandbox Snapshot] Loaded snapshot from database for project: ${projectId}`)
      // @ts-ignore
      return metadata.backendStateGraph._sandboxSnapshot as SandboxSnapshot
    }
  } catch (error) {
    console.error(`[Sandbox Snapshot] Failed to load snapshot:`, error)
  }

  return null
}

/**
 * Check if sandbox snapshot exists and is fresh
 * 
 * @param projectId - Project ID to check
 * @param maxAgeMs - Maximum age in milliseconds (default: 1 hour)
 * @returns True if snapshot exists and is fresh
 */
export async function hasFreshSnapshot(
  projectId: string,
  maxAgeMs: number = 60 * 60 * 1000
): Promise<boolean> {
  const snapshot = await loadSandboxSnapshot(projectId)
  
  if (!snapshot) {
    return false
  }

  const age = Date.now() - new Date(snapshot.preparedAt).getTime()
  return age < maxAgeMs
}

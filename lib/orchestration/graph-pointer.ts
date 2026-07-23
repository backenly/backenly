/**
 * UNIFIED GRAPH POINTER ARCHITECTURE
 * 
 * Single source of truth for ALL projects (PRIVATE and LIVE):
 * - BackendGraph table stores immutable graph snapshots
 * - Project.activeGraphId points to current graph
 * - All mutations create NEW BackendGraph rows
 * - Never update existing graphData
 * 
 * Flow:
 * 1. Get active graph
 * 2. Apply mutations in memory
 * 3. Validate
 * 4. Create new BackendGraph row
 * 5. Atomic UPDATE activeGraphId
 */

import { prisma } from '@/lib/db/prisma'
import type { BackendStateGraph } from './backend-state-graph'

/**
 * Minimal system event logging
 * 
 * For 1000 users: Simple console + database logging is sufficient
 * No need for complex metrics platforms yet
 */
interface SystemEvent {
  event: 'billing_limit_violation' | 'pointer_swap' | 'graph_mutation_failed' | 'intent_validation_failed'
  projectId?: string
  graphId?: string
  sequenceNumber?: number
  details?: Record<string, any>
  timestamp: string
}

// In-memory event buffer (flush to console immediately, DB periodically)
const eventBuffer: SystemEvent[] = []

/**
 * Log system event
 * 
 * Minimal observability for 1000-user launch:
 * - Console logging (immediate visibility)
 * - Database table (persistent history)
 * - No external metrics services needed yet
 */
async function logSystemEvent(event: Omit<SystemEvent, 'timestamp'>): Promise<void> {
  const fullEvent: SystemEvent = {
    ...event,
    timestamp: new Date().toISOString(),
  }
  
  // Always log to console (immediate visibility)
  console.log(`[SystemEvent] ${event.event}`, {
    projectId: event.projectId,
    graphId: event.graphId,
    details: event.details,
  })
  
  // Buffer for batch DB writes
  eventBuffer.push(fullEvent)
  
  // Flush to database every 10 events or immediately for critical events
  if (eventBuffer.length >= 10 || event.event === 'billing_limit_violation') {
    await flushEventBuffer()
  }
}

/**
 * Flush event buffer to database
 */
async function flushEventBuffer(): Promise<void> {
  if (eventBuffer.length === 0) return
  
  const events = eventBuffer.splice(0, eventBuffer.length)
  
  try {
    // Write to SystemEvent table (create if not exists)
    await prisma.$executeRaw`
      INSERT INTO system_events (event, project_id, graph_id, sequence_number, details, created_at)
      VALUES ${events.map(e => 
        `('${e.event}', '${e.projectId || ''}', '${e.graphId || ''}', ${e.sequenceNumber || 'NULL'}, '${JSON.stringify(e.details)}', '${e.timestamp}')`
      ).join(', ')}
    `
  } catch (error) {
    // If table doesn't exist, just log to console (non-critical)
    console.log('[SystemEvent] DB write failed (table may not exist), events:', events.length)
  }
}

/**
 * Sanitize graph before saving to prevent Prisma validation errors
 * Removes undefined values from arrays and objects
 */
function sanitizeGraph(graph: BackendStateGraph): BackendStateGraph {
  const sanitized = JSON.parse(JSON.stringify(graph, (key, value) => {
    // Remove undefined from arrays
    if (Array.isArray(value)) {
      return value.filter(item => item !== undefined && item !== null)
    }
    // Skip undefined values in objects
    if (value === undefined) {
      return undefined
    }
    return value
  }))
  
  // Additional sanitization for API methods
  if (sanitized.apis) {
    Object.values(sanitized.apis).forEach((api: any) => {
      if (api.methods) {
        api.methods = api.methods.filter((m: any) => m && typeof m === 'string')
        // If no valid methods, default to GET
        if (api.methods.length === 0) {
          api.methods = ['GET']
        }
      }
    })
  }
  
  return sanitized
}

/**
 * Get the active graph for a project (universal for PRIVATE and LIVE)
 */
export async function getActiveGraph(projectId: string): Promise<BackendStateGraph | null> {
  // INTEGRATION MODE: Read from in-memory store (bypass Prisma)
  if (process.env.ENGINE_MODE === 'integration') {
    // Access the in-memory store from orchestration/index.ts
    // Using require to avoid circular dependency at module load
    const { integrationGraphStore } = require('./index')
    const history = integrationGraphStore.get(projectId)
    // Return a DEEP COPY of the last graph in history (current active graph)
    // This prevents accidental mutation of the stored graph
    if (history && history.length > 0) {
      return JSON.parse(JSON.stringify(history[history.length - 1]))
    }
    return null
  }
  
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      activeGraph: true,
    },
  })

  if (!project?.activeGraph) {
    return null
  }

  return project.activeGraph.graphData as unknown as BackendStateGraph
}

/**
 * Create initial graph for new project
 */
export async function createInitialGraph(
  projectId: string,
  initialGraph: BackendStateGraph
): Promise<string> {
  const sanitized = sanitizeGraph(initialGraph)
  
  // INTEGRATION MODE: Store in memory only
  if (process.env.ENGINE_MODE === 'integration') {
    const { integrationGraphStore } = require('./index')
    const history = integrationGraphStore.get(projectId) || []
    history.push(sanitized)
    integrationGraphStore.set(projectId, history)
    console.log('[Graph Pointer] 🧪 INTEGRATION MODE - Initial graph stored in memory')
    return `integration-graph-${projectId}-0`
  }
  
  // Check if project exists first (prevents foreign key errors in tests)
  const project = await prisma.project.findUnique({
    where: { id: projectId }
  })
  
  if (!project) {
    throw new Error(`Project ${projectId} not found - cannot create graph`)
  }
  
  const graph = await prisma.backendGraph.create({
    data: {
      projectId,
      graphData: sanitized as any,
    },
  })

  // Set as active
  await prisma.project.update({
    where: { id: projectId },
    data: { activeGraphId: graph.id },
  })

  console.log('[Graph Pointer] ✅ Initial graph created:', graph.id)

  return graph.id
}

/**
 * Save mutated graph (creates NEW immutable row)
 * Used by both PRIVATE and LIVE projects
 * 
 * CONCURRENCY SAFE: Uses optimistic locking
 * DETERMINISTIC UNDO: Uses sequence numbers
 * 
 * RETURNS: The created graph record (for suggestion layer)
 */
export async function saveNewGraph(
  projectId: string,
  mutatedGraph: BackendStateGraph,
  intentId?: string,
  options?: {
    estimatedRows?: number
    skipBillingCheck?: boolean
  }
): Promise<{ id: string; sequenceNumber: number }> {
  return await prisma.$transaction(async (tx) => {
    // PHASE -1: PROJECT-LEVEL MUTATION LOCK (CRITICAL FOR SCALE)
    // PostgreSQL advisory lock: serializes mutations per project
    // Lightweight, transaction-scoped, automatically released on commit/rollback
    // Prevents race conditions under heavy concurrent load (10k-100k users)
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${projectId}))
    `
    console.log('[Graph Pointer] 🔒 Project mutation lock acquired:', projectId)
    
    // PHASE 0: BILLING ENFORCEMENT (Inside Transaction)
    // Critical: Check limits before any mutation
    if (!options?.skipBillingCheck) {
      const project = await tx.project.findUnique({
        where: { id: projectId },
        select: { rowCount: true, storageUsed: true, userId: true },
      })
      
      if (project && options?.estimatedRows) {
        // Get user's plan limits
        const user = await tx.user.findUnique({
          where: { id: project.userId || '' },
          include: {
            subscriptions: {
              where: { status: { in: ['ACTIVE', 'FREE', 'GRACE'] } },
              orderBy: { createdAt: 'desc' },
              take: 1,
              include: { plan: true },
            },
          },
        })
        
        const plan = user?.subscriptions[0]?.plan
        const rowLimit = plan?.maxRowsPerProject || 1000 // Default FREE limit
        
        // Check row limit inside transaction (prevents race conditions)
        if (project.rowCount + options.estimatedRows > rowLimit) {
          // Log billing violation
          await logSystemEvent({
            event: 'billing_limit_violation',
            projectId,
            details: {
              resource: 'rows',
              current: project.rowCount,
              limit: rowLimit,
              attempted: options.estimatedRows,
            },
          })
          throw new Error(`BILLING_LIMIT_EXCEEDED: rows (${project.rowCount}/${rowLimit})`)
        }
      }
    }
    
    // Get current activeGraphId for optimistic locking
    const currentProject = await tx.project.findUnique({
      where: { id: projectId },
      select: { activeGraphId: true },
    })
    
    const expectedActiveGraphId = currentProject?.activeGraphId
    
    // Get current sequence number - USE MAX to avoid collisions
    const maxSequenceResult = await tx.backendGraph.aggregate({
      where: { projectId },
      _max: { sequenceNumber: true },
    })
    const nextSequence = (maxSequenceResult._max.sequenceNumber || 0) + 1
    
    console.log('[Graph Pointer] Next sequence number:', nextSequence)
    
    try {
      // Sanitize graph to prevent Prisma validation errors
      const sanitized = sanitizeGraph(mutatedGraph)
      
      // Create NEW BackendGraph row (immutable)
      const newGraph = await tx.backendGraph.create({
        data: {
          projectId,
          graphData: sanitized as any,
          intentId: intentId || null,
          sequenceNumber: nextSequence,
        },
      })

      console.log('[Graph Pointer] ✅ New graph created:', newGraph.id, 'sequence:', nextSequence)

      // ATOMIC SWAP with optimistic locking
      const updateResult = await tx.project.updateMany({
        where: {
          id: projectId,
          activeGraphId: expectedActiveGraphId, // Optimistic lock
        },
        data: { activeGraphId: newGraph.id },
      })
      
      if (updateResult.count === 0) {
        // Concurrent modification - clean up orphan graph
        await tx.backendGraph.delete({
          where: { id: newGraph.id },
        })
        throw new Error('CONCURRENCY_CONFLICT')
      }

      // Log successful mutation
      await logSystemEvent({
        event: 'pointer_swap',
        projectId,
        graphId: newGraph.id,
        sequenceNumber: nextSequence,
        details: { intentId },
      })

      console.log('[Graph Pointer] ✅ Pointer swapped to:', newGraph.id)
      
      // Return graph info
      return { id: newGraph.id, sequenceNumber: nextSequence }
      
    } catch (error: any) {
      // Log mutation failure
      await logSystemEvent({
        event: 'graph_mutation_failed',
        projectId,
        details: {
          error: error.message,
          code: error.code,
          intentId,
        },
      })
      
      // Handle Prisma unique constraint violation (P2002)
      if (error.code === 'P2002') {
        console.error('[Graph Pointer] ❌ Sequence conflict detected (P2002)')
        throw new Error('CONCURRENCY_CONFLICT')
      }
      throw error
    }
  })
}

/**
 * Check if project is LIVE
 */
export async function isProjectLive(projectId: string): Promise<boolean> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { projectStatus: true },
  })

  return project?.projectStatus === 'LIVE'
}

/**
 * Get previous graph ID for undo
 * Uses sequenceNumber for deterministic ordering
 */
export async function getPreviousGraphId(projectId: string): Promise<string | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { activeGraph: true },
  })

  if (!project?.activeGraph) {
    return null
  }

  const currentSequence = project.activeGraph.sequenceNumber

  // Find graph with sequence = current - 1
  const previousGraph = await prisma.backendGraph.findFirst({
    where: {
      projectId,
      sequenceNumber: currentSequence - 1,
    },
  })

  return previousGraph?.id || null
}

/**
 * UNDO with optimistic locking - prevents race conditions
 */
export async function undoToGraph(
  projectId: string,
  targetGraphId: string
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Verify target graph exists and belongs to project
    const targetGraph = await tx.backendGraph.findFirst({
      where: {
        id: targetGraphId,
        projectId,
      },
    })

    if (!targetGraph) {
      throw new Error('Target graph not found')
    }

    // Get current activeGraphId for optimistic locking
    const project = await tx.project.findUnique({
      where: { id: projectId },
      select: { activeGraphId: true },
    })

    if (!project?.activeGraphId) {
      throw new Error('UNDO_CONFLICT: No active graph to undo from')
    }

    // ATOMIC SWAP with optimistic locking - prevents concurrent overwrites
    const updateResult = await tx.project.updateMany({
      where: {
        id: projectId,
        activeGraphId: project.activeGraphId, // Lock on current state
      },
      data: { activeGraphId: targetGraphId },
    })

    if (updateResult.count === 0) {
      throw new Error('UNDO_CONFLICT: Project was modified during undo. Please retry.')
    }

    console.log('[Graph Pointer] ✅ UNDO COMPLETE - Swapped to:', targetGraphId)
  })
}

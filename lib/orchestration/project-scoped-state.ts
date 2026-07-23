/**
 * PHASE 4: Project-Scoped Orchestration State
 * 
 * Separate intent logs, schema, API, auth, and deployment states per project
 * Orchestration decisions based ONLY on current project's history
 */

import { ExecutionContext, assertExecutionContext } from '@/lib/context/execution-context'
import { PrismaClient } from '@prisma/client'
import { BackendStateGraph } from './backend-state-graph'

const prisma = new PrismaClient()

// In-memory storage for orchestration state in this process.
// In production these would be backed by the database.
const inMemoryIntentLogs: Record<string, IntentLogEntry[]> = {}
const inMemoryProjectState: Record<string, ProjectOrchestrationState> = {}

/**
 * Intent log entry (project-scoped)
 */
export interface IntentLogEntry {
  id: string
  projectId: string
  executionId: string
  intent: string
  canonicalIntent: any
  timestamp: Date
  success: boolean
  changes: any
  rollbackData?: any
}

/**
 * Project orchestration state
 */
export interface ProjectOrchestrationState {
  projectId: string
  currentGraph: BackendStateGraph
  intentHistory: IntentLogEntry[]
  lastUpdate: Date
  version: number
}

/**
 * Log intent execution for project
 * 
 * CRITICAL: Intent logs completely isolated per project
 */
export async function logIntentExecution(
  context: ExecutionContext,
  intent: string,
  canonicalIntent: any,
  success: boolean,
  changes: any,
  rollbackData?: any,
  liveMutation?: boolean,
  liveMutationStatus?: string
): Promise<IntentLogEntry> {
  assertExecutionContext(context)
  
  // Create log entry
  const entry: IntentLogEntry = {
    id: `intent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    projectId: context.projectId,
    executionId: context.executionId,
    intent,
    canonicalIntent,
    timestamp: new Date(),
    success,
    changes,
    rollbackData,
  }
  
  // Persist to database
  try {
    // In integration mode, store minimal data only to prevent storage bloat
    const isIntegrationMode = process.env.ENGINE_MODE === 'integration'
    
    await prisma.intentLog.create({
      data: {
        id: entry.id,
        projectId: entry.projectId,
        executionId: entry.executionId,
        intent: entry.intent,
        canonicalIntent: isIntegrationMode ? null : JSON.parse(JSON.stringify(entry.canonicalIntent ?? null)),
        timestamp: entry.timestamp,
        success: entry.success,
        changes: isIntegrationMode ? null : JSON.parse(JSON.stringify(entry.changes ?? null)),
        rollbackData: isIntegrationMode ? null : JSON.parse(JSON.stringify(entry.rollbackData ?? null)),
        liveMutation: liveMutation || false,
        liveMutationStatus: liveMutationStatus || null,
      },
    })
  } catch (error) {
    console.error(`[Orchestration State] Failed to persist intent log to database:`, error)
  }
  
  // Also keep in memory for fast access (cache)
  const existing = inMemoryIntentLogs[context.projectId] || []
  inMemoryIntentLogs[context.projectId] = [...existing, entry]
  
  console.log(
    `[Orchestration State] Logged intent for project ${context.projectId}: ${intent.substring(0, 50)}...`
  )
  
  return entry
}

/**
 * Get intent history for project
 * 
 * ONLY returns history for this specific project
 */
export async function getIntentHistory(
  context: ExecutionContext,
  limit = 50
): Promise<IntentLogEntry[]> {
  assertExecutionContext(context)
  
  // Try to load from database first
  try {
    const dbLogs = await prisma.intentLog.findMany({
      where: { projectId: context.projectId },
      orderBy: { timestamp: 'asc' },
      take: limit,
    })
    
    // Convert to IntentLogEntry format
    const entries: IntentLogEntry[] = dbLogs.map(log => ({
      id: log.id,
      projectId: log.projectId,
      executionId: log.executionId,
      intent: log.intent,
      canonicalIntent: log.canonicalIntent as any,
      timestamp: log.timestamp,
      success: log.success,
      changes: log.changes as any,
      rollbackData: log.rollbackData as any,
    }))
    
    // Update memory cache
    inMemoryIntentLogs[context.projectId] = entries
    
    return entries
  } catch (error) {
    console.error(`[Orchestration State] Failed to load intent history from database:`, error)
    // Fall back to memory cache
    const history = inMemoryIntentLogs[context.projectId] || []
    if (!limit || history.length <= limit) {
      return history
    }
    return history.slice(history.length - limit)
  }
}

/**
 * Get last successful intent for project
 * 
 * Used for rollback operations
 * First checks in-memory cache, then falls back to database
 */
export async function getLastSuccessfulIntent(
  context: ExecutionContext
): Promise<IntentLogEntry | null> {
  assertExecutionContext(context)
  
  // Check in-memory cache first
  const history = inMemoryIntentLogs[context.projectId] || []
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].success) {
      console.log(`[Orchestration State] Found last successful intent in memory: ${history[i].id}`)
      return history[i]
    }
  }
  
  // Fall back to database if not in memory
  try {
    const dbIntent = await prisma.intentLog.findFirst({
      where: {
        projectId: context.projectId,
        success: true,
      },
      orderBy: {
        timestamp: 'desc',
      },
    })
    
    if (dbIntent) {
      console.log(`[Orchestration State] Found last successful intent in database: ${dbIntent.id}`)
      
      // Convert database record to IntentLogEntry
      const entry: IntentLogEntry = {
        id: dbIntent.id,
        projectId: dbIntent.projectId,
        executionId: dbIntent.executionId,
        intent: dbIntent.intent,
        canonicalIntent: dbIntent.canonicalIntent as any,
        timestamp: dbIntent.timestamp,
        success: dbIntent.success,
        changes: dbIntent.changes as any,
        rollbackData: dbIntent.rollbackData as any,
      }
      
      return entry
    }
  } catch (error) {
    console.error(`[Orchestration State] Failed to query database for last intent:`, error)
  }
  
  console.log(`[Orchestration State] No successful intent found for project ${context.projectId}`)
  return null
}

/**
 * Save project orchestration state
 * 
 * Completely isolated per project
 */
export async function saveProjectState(
  context: ExecutionContext,
  graph: BackendStateGraph
): Promise<void> {
  assertExecutionContext(context)
  
  const previous = inMemoryProjectState[context.projectId]
  const state: ProjectOrchestrationState = {
    projectId: context.projectId,
    currentGraph: graph,
    intentHistory: inMemoryIntentLogs[context.projectId] || [],
    lastUpdate: new Date(),
    version: (previous?.version || 0) + 1,
  }
  
  inMemoryProjectState[context.projectId] = state
  
  console.log(
    `[Orchestration State] Saved state for project ${context.projectId} (version ${state.version})`
  )
}

/**
 * Load project orchestration state
 * 
 * ONLY returns state for this specific project
 */
export async function loadProjectState(
  context: ExecutionContext
): Promise<ProjectOrchestrationState | null> {
  assertExecutionContext(context)
  
  return inMemoryProjectState[context.projectId] || null
}

/**
 * Get orchestration decisions based on project history
 * 
 * CRITICAL: Uses ONLY current project's history
 */
export async function getOrchestrationContext(
  context: ExecutionContext
): Promise<{
  previousIntents: string[]
  currentState: BackendStateGraph | null
  recentChanges: any[]
}> {
  assertExecutionContext(context)
  
  const history = await getIntentHistory(context, 10)
  const state = await loadProjectState(context)
  
  return {
    previousIntents: history.map(h => h.intent),
    currentState: state?.currentGraph || null,
    recentChanges: history.map(h => h.changes).filter(Boolean),
  }
}

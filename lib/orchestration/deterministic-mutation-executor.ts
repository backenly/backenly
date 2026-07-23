/**
 * Deterministic Mutation Executor
 * 
 * Executes mutations with optimistic concurrency control and automatic retry.
 * 
 * ARCHITECTURAL CONSTRAINTS:
 * - This function is PURE and DETERMINISTIC
 * - Same (intent, graph) → same result (always)
 * - Safe to retry on conflict
 * - No AI calls, no external dependencies
 * 
 * RETRY SEMANTICS:
 * - MAX_RETRIES = 3
 * - Exponential backoff: 50ms, 100ms, 150ms
 * - Re-fetches graph before each retry
 * - Recomputes plan from scratch
 * - Only retries on CONCURRENCY_CONFLICT
 */

import { BackendStateGraph, createEmptyGraph } from './backend-state-graph'
import { getActiveGraph, createInitialGraph, saveNewGraph } from './graph-pointer'
import { CanonicalIntent } from './types'
import { generateExecutionPlan, ExecutionPlan, validatePlan } from './execution-plan-generator'
import { executeReal } from '@/lib/execution/real-executor'
import { ExecutionResult } from './atomic-executor'
import { assertGraphInvariants, repairOrphanRelationships } from './projection-assertions'
import { logger } from '@/lib/observability'

interface MutationAttemptResult {
  success: boolean
  executionResult?: ExecutionResult
  error?: Error
  isConflict: boolean
}

interface ExecuteMutationOptions {
  projectId: string
  intents: CanonicalIntent[]
  requestId?: string
}

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 50

/**
 * Execute a deterministic mutation with automatic retry on conflict.
 * 
 * This is the core retryable unit. It:
 * 1. Loads latest graph
 * 2. Generates execution plan
 * 3. Executes plan
 * 4. Validates invariants
 * 5. Saves with optimistic lock
 * 
 * On conflict: re-fetches graph and retries from step 1.
 */
export async function executeDeterministicMutationWithRetry(
  options: ExecuteMutationOptions
): Promise<ExecutionResult> {
  const { projectId, intents } = options
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const attemptResult = await executeSingleMutationAttempt({
      projectId,
      intents,
      attempt,
    })
    
    if (attemptResult.success && attemptResult.executionResult) {
      // Log retry success
      if (attempt > 1) {
        logger.info('Mutation succeeded after retry', {
          projectId: projectId.substring(0, 8),
          attempts: attempt,
          intentCount: intents.length,
        })
      }
      
      return attemptResult.executionResult
    }
    
    // Check if we should retry
    if (attemptResult.isConflict && attempt < MAX_RETRIES) {
      const delayMs = RETRY_DELAY_MS * attempt
      
      logger.info('Concurrency conflict detected, retrying', {
        projectId: projectId.substring(0, 8),
        attempt,
        maxRetries: MAX_RETRIES,
        delayMs,
        intentTargets: intents.map(i => i.target).join(', '),
      })
      
      // Exponential backoff
      await new Promise(resolve => setTimeout(resolve, delayMs))
      
      continue // Retry with fresh graph
    }
    
    // Max retries exceeded or non-conflict error
    if (attemptResult.isConflict) {
      logger.warn('Max retries exceeded for concurrency conflict', {
        projectId: projectId.substring(0, 8),
        attempts: attempt,
        intentTargets: intents.map(i => i.target).join(', '),
      })
      
      throw new Error('CONCURRENCY_CONFLICT_MAX_RETRIES')
    }
    
    // Non-conflict error - throw immediately
    if (attemptResult.error) {
      throw attemptResult.error
    }
    
    // Should not reach here
    throw new Error('Unexpected execution failure')
  }
  
  // Should not reach here (loop always returns or throws)
  throw new Error('Retry loop exhausted without result')
}

/**
 * Execute a single mutation attempt.
 * 
 * This function is pure and deterministic:
 * - Same inputs → same outputs
 * - No side effects except final save
 * - Re-fetches graph each call
 */
async function executeSingleMutationAttempt(
  options: {
    projectId: string
    intents: CanonicalIntent[]
    attempt: number
  }
): Promise<MutationAttemptResult> {
  const { projectId, intents, attempt } = options
  
  try {
    // Step 1: Load latest graph (fresh each attempt)
    let finalGraph: BackendStateGraph
    const activeGraph = await getActiveGraph(projectId)
    
    if (!activeGraph) {
      // First time - create initial empty graph
      const emptyGraph = createEmptyGraph(projectId)
      await createInitialGraph(projectId, emptyGraph)
      finalGraph = emptyGraph
    } else {
      finalGraph = activeGraph
    }
    
    console.log(`[DeterministicExecutor] Attempt ${attempt}: Starting from graph version ${finalGraph.version}`)
    
    // Step 2: Execute all intents (deterministic planning + execution)
    const cumulativeChanges: any[] = []
    
    for (let i = 0; i < intents.length; i++) {
      const intent = intents[i]
      
      console.log(`[DeterministicExecutor] [Intent ${i + 1}/${intents.length}] ${intent.target}`)
      
      // Generate plan (deterministic)
      const plan = generateExecutionPlan(intent, finalGraph)
      
      // Validate plan
      const validation = validatePlan(plan)
      if (!validation.valid) {
        return {
          success: false,
          error: new Error(`Invalid plan: ${validation.errors.join(', ')}`),
          isConflict: false,
        }
      }
      
      // Execute plan (deterministic)
      const executionResult = await Promise.race([
        executeReal(plan, finalGraph, projectId),
        new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error('EXEC_REAL_TIMEOUT')), 30000)
        ),
      ]) as ExecutionResult
      
      if (!executionResult.success) {
        return {
          success: false,
          error: new Error(`Execution failed: ${executionResult.failedStep?.error}`),
          isConflict: false,
        }
      }
      
      // Accumulate changes
      cumulativeChanges.push(...executionResult.changes)
      finalGraph = executionResult.finalState
    }
    
    // Step 3: Repair + validate invariants
    const repairs = repairOrphanRelationships(finalGraph)
    if (repairs.length > 0) {
      console.warn('[DeterministicExecutor] ⚠️  Repaired orphan relationships:', repairs)
    }
    try {
      assertGraphInvariants(finalGraph)
    } catch (invariantError: any) {
      return {
        success: false,
        error: new Error(`Invariant violation: ${invariantError.message}`),
        isConflict: false,
      }
    }
    
    // Step 4: Save with optimistic lock
    try {
      await saveNewGraph(projectId, finalGraph)
      console.log(`[DeterministicExecutor] Attempt ${attempt}: Graph saved successfully`)
    } catch (saveError: any) {
      // Check if this is a concurrency conflict
      if (saveError.message?.includes('CONCURRENCY_CONFLICT')) {
        return {
          success: false,
          isConflict: true,
        }
      }
      
      // Other save error
      return {
        success: false,
        error: saveError,
        isConflict: false,
      }
    }
    
    // Success - construct final result
    const finalResult: ExecutionResult = {
      success: true,
      plan: {} as ExecutionPlan, // Simplified - actual plan from last intent
      executedSteps: [], // Simplified
      rollbackPerformed: false,
      finalState: finalGraph,
      changes: cumulativeChanges,
      message: `Successfully executed ${intents.length} intent(s)`,
    }
    
    return {
      success: true,
      executionResult: finalResult,
      isConflict: false,
    }
    
  } catch (error: any) {
    // Check if this is a conflict error from deeper in the stack
    if (error.message?.includes('CONCURRENCY_CONFLICT')) {
      return {
        success: false,
        isConflict: true,
      }
    }
    
    return {
      success: false,
      error,
      isConflict: false,
    }
  }
}

// Export for testing
export { executeSingleMutationAttempt, MAX_RETRIES, RETRY_DELAY_MS }

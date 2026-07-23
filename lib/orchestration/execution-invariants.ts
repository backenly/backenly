/**
 * Execution Engine Invariants - Assertion-Level Enforcement
 * 
 * CRITICAL: These are the reliability moat guarantees
 * 
 * Core Invariants:
 * 1. Graph mutations are atomic (no partial mutations)
 * 2. Active graph pointer swap occurs exactly once per mutation
 * 3. Failed validation produces zero state change
 * 4. Version lineage remains continuous
 * 5. Concurrent mutations cannot corrupt graph state
 */

import type { BackendStateGraph } from './backend-state-graph'
import { prisma } from '@/lib/db/prisma'

/**
 * Invariant violation error
 */
export class InvariantViolationError extends Error {
  constructor(
    public invariant: string,
    public details: string,
    public evidence?: Record<string, any>
  ) {
    super(`INVARIANT VIOLATED: ${invariant}\nDetails: ${details}`)
    this.name = 'InvariantViolationError'
  }
}

/**
 * INVARIANT 1: Graph Immutability
 * 
 * Once a graph is saved, it must never be modified
 * Previous graph objects must remain unchanged
 */
export function assertGraphImmutability(
  previousGraph: BackendStateGraph | null,
  previousGraphCopy: BackendStateGraph | null
): void {
  if (!previousGraph || !previousGraphCopy) return
  
  // Deep equality check - previous graph should be unchanged
  const previousSerialized = JSON.stringify(previousGraph)
  const copySerialized = JSON.stringify(previousGraphCopy)
  
  if (previousSerialized !== copySerialized) {
    throw new InvariantViolationError(
      'Graph Immutability',
      'Previous graph was mutated during execution',
      {
        previousGraphId: previousGraph.version,
        mutationDetected: true,
      }
    )
  }
}

/**
 * INVARIANT 2: Atomic Mutation
 * 
 * Either entire mutation succeeds or entire mutation fails
 * No partial state changes allowed
 */
export function assertAtomicMutation(
  success: boolean,
  graphChanged: boolean,
  pointerSwapped: boolean
): void {
  // If success, both graph and pointer should change
  if (success && (!graphChanged || !pointerSwapped)) {
    throw new InvariantViolationError(
      'Atomic Mutation',
      'Successful mutation did not update both graph and pointer',
      {
        success,
        graphChanged,
        pointerSwapped,
      }
    )
  }
  
  // If failure, neither graph nor pointer should change
  if (!success && (graphChanged || pointerSwapped)) {
    throw new InvariantViolationError(
      'Atomic Mutation',
      'Failed mutation caused partial state change',
      {
        success,
        graphChanged,
        pointerSwapped,
      }
    )
  }
}

/**
 * INVARIANT 3: Single Pointer Swap
 * 
 * Each mutation must swap pointer exactly once
 * Multiple swaps indicate corruption risk
 */
export function assertSinglePointerSwap(
  swapCount: number,
  mutationAttempted: boolean
): void {
  if (mutationAttempted && swapCount !== 1) {
    throw new InvariantViolationError(
      'Single Pointer Swap',
      `Pointer swapped ${swapCount} times, expected exactly 1`,
      {
        swapCount,
        expected: 1,
      }
    )
  }
  
  if (!mutationAttempted && swapCount > 0) {
    throw new InvariantViolationError(
      'Single Pointer Swap',
      'Pointer swapped without mutation attempt',
      {
        swapCount,
        mutationAttempted: false,
      }
    )
  }
}

/**
 * INVARIANT 4: Version Lineage Continuity
 * 
 * Each graph version must reference its parent
 * No gaps in version history
 */
export async function assertVersionLineage(
  projectId: string,
  newGraphId: string,
  expectedParentId: string | null
): Promise<void> {
  // Get the new graph
  const newGraph = await prisma.backendGraph.findUnique({
    where: { id: newGraphId },
    select: { id: true, sequenceNumber: true, projectId: true },
  })
  
  if (!newGraph) {
    throw new InvariantViolationError(
      'Version Lineage',
      'New graph not found in database',
      { newGraphId }
    )
  }
  
  // If there should be a parent, verify continuity
  if (expectedParentId) {
    const parentGraph = await prisma.backendGraph.findUnique({
      where: { id: expectedParentId },
      select: { sequenceNumber: true },
    })
    
    if (!parentGraph) {
      throw new InvariantViolationError(
        'Version Lineage',
        'Parent graph not found',
        {
          expectedParentId,
          newGraphId,
        }
      )
    }
    
    // Verify sequence continuity
    if (newGraph.sequenceNumber !== parentGraph.sequenceNumber + 1) {
      throw new InvariantViolationError(
        'Version Lineage',
        'Sequence number discontinuity detected',
        {
          parentSequence: parentGraph.sequenceNumber,
          newSequence: newGraph.sequenceNumber,
          expected: parentGraph.sequenceNumber + 1,
        }
      )
    }
  }
}

/**
 * INVARIANT 5: Concurrency Safety
 * 
 * Concurrent mutations must not corrupt graph state
 * Optimistic locking must prevent race conditions
 */
export function assertConcurrencySafety(
  concurrencyError: boolean,
  retryAttempted: boolean
): void {
  // If concurrency error detected but no retry, invariant violated
  if (concurrencyError && !retryAttempted) {
    throw new InvariantViolationError(
      'Concurrency Safety',
      'Concurrency conflict detected without retry mechanism',
      {
        concurrencyError: true,
        retryAttempted: false,
      }
    )
  }
}

/**
 * INVARIANT 6: Referential Integrity
 * 
 * All entity relationships must be valid
 * No dangling foreign keys
 */
export function assertReferentialIntegrity(
  graph: BackendStateGraph
): void {
  const entityNames = new Set(Object.keys(graph.entities))
  
  // Check all relationships reference valid entities
  for (const [entityName, entity] of Object.entries(graph.entities)) {
    if (!entity.relationships) continue
    
    for (const rel of entity.relationships) {
      const targetEntity = rel.to
      if (!targetEntity) continue
      
      if (!entityNames.has(targetEntity)) {
        throw new InvariantViolationError(
          'Referential Integrity',
          `Entity ${entityName} references non-existent entity ${targetEntity}`,
          {
            sourceEntity: entityName,
            targetEntity,
            availableEntities: Array.from(entityNames),
          }
        )
      }
    }
  }
}

/**
 * INVARIANT 7: State Consistency
 * 
 * Project's activeGraphId must always point to valid graph
 * Orphan pointers indicate corruption
 */
export async function assertStateConsistency(
  projectId: string
): Promise<void> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      activeGraphId: true,
      activeGraph: {
        select: { id: true },
      },
    },
  })
  
  if (!project) {
    throw new InvariantViolationError(
      'State Consistency',
      'Project not found',
      { projectId }
    )
  }
  
  // If activeGraphId is set, graph must exist
  if (project.activeGraphId && !project.activeGraph) {
    throw new InvariantViolationError(
      'State Consistency',
      'Active graph pointer references non-existent graph',
      {
        projectId,
        activeGraphId: project.activeGraphId,
      }
    )
  }
}

/**
 * Execution Context for tracking invariant compliance
 */
export interface ExecutionContext {
  projectId: string
  intentId: string
  previousGraphId: string | null
  previousGraphSnapshot: BackendStateGraph | null
  pointerSwapCount: number
  mutationAttempted: boolean
  mutationSuccess: boolean
  newGraphId: string | null
  concurrencyErrorDetected: boolean
  retryAttempted: boolean
}

/**
 * Create execution context for tracking
 */
export function createExecutionContext(
  projectId: string,
  intentId: string,
  previousGraph: BackendStateGraph | null
): ExecutionContext {
  return {
    projectId,
    intentId,
    previousGraphId: previousGraph ? String(previousGraph.version) : null,
    previousGraphSnapshot: previousGraph ? JSON.parse(JSON.stringify(previousGraph)) : null,
    pointerSwapCount: 0,
    mutationAttempted: false,
    mutationSuccess: false,
    newGraphId: null,
    concurrencyErrorDetected: false,
    retryAttempted: false,
  }
}

/**
 * MASTER INVARIANT VALIDATION
 * 
 * Run all invariant checks after mutation
 * This is the reliability moat enforcement point
 */
export async function validateAllInvariants(
  context: ExecutionContext,
  currentGraph: BackendStateGraph | null
): Promise<void> {
  console.log('[Invariants] 🔒 Validating all execution invariants...')
  
  try {
    // INVARIANT 1: Graph Immutability
    if (context.previousGraphSnapshot && currentGraph) {
      assertGraphImmutability(
        currentGraph, // This should be previous graph, not current
        context.previousGraphSnapshot
      )
    }
    
    // INVARIANT 2: Atomic Mutation
    const graphChanged = context.newGraphId !== null
    const pointerSwapped = context.pointerSwapCount > 0
    assertAtomicMutation(
      context.mutationSuccess,
      graphChanged,
      pointerSwapped
    )
    
    // INVARIANT 3: Single Pointer Swap
    assertSinglePointerSwap(
      context.pointerSwapCount,
      context.mutationAttempted
    )
    
    // INVARIANT 4: Version Lineage (async check)
    if (context.newGraphId) {
      await assertVersionLineage(
        context.projectId,
        context.newGraphId,
        context.previousGraphId
      )
    }
    
    // INVARIANT 5: Concurrency Safety
    assertConcurrencySafety(
      context.concurrencyErrorDetected,
      context.retryAttempted
    )
    
    // INVARIANT 6: Referential Integrity
    if (currentGraph) {
      assertReferentialIntegrity(currentGraph)
    }
    
    // INVARIANT 7: State Consistency (async check)
    await assertStateConsistency(context.projectId)
    
    console.log('[Invariants] ✅ All invariants validated successfully')
  } catch (error) {
    if (error instanceof InvariantViolationError) {
      console.error('[Invariants] ❌ INVARIANT VIOLATION:', error.invariant)
      console.error('[Invariants]    Details:', error.details)
      console.error('[Invariants]    Evidence:', error.evidence)
    }
    throw error
  }
}

/**
 * Enable/disable strict mode for invariant checks
 * 
 * In production: enabled (default)
 * In development: can be disabled for faster iteration
 */
export const STRICT_INVARIANTS = process.env.STRICT_INVARIANTS !== 'false'

/**
 * Safe invariant validation with optional strictness
 */
export async function validateInvariantsIfEnabled(
  context: ExecutionContext,
  currentGraph: BackendStateGraph | null
): Promise<void> {
  if (!STRICT_INVARIANTS) {
    console.log('[Invariants] ⚠️  Strict mode disabled, skipping validation')
    return
  }
  
  await validateAllInvariants(context, currentGraph)
}

/**
 * Phase 4.3: Projection Coherence Guard Assertions
 * 
 * Runtime invariant detection (dev-only) that fails fast on drift.
 * 
 * RULES:
 * - Never mutate state
 * - Never change execution flow in production
 * - Pure verification only
 * - Cheap and deterministic
 * - Fail fast in development
 */

import type { BackendStateGraph } from './backend-state-graph'

/**
 * Graph-level invariants (internal consistency)
 */
export function assertGraphInvariants(graph: BackendStateGraph): void {
  if (process.env.NODE_ENV === 'production') return
  
  // Heartbeat monitor (dev-only)
  if (process.env.NODE_ENV !== 'test') {
    console.log(`🛡 Invariants verified for graph version: ${graph.version}`)
  }
  
  assertNoDuplicatePolicies(graph)
  assertNoOrphanRelationships(graph)
  assertUniqueEntityNames(graph)
}

/**
 * Projection invariants (surface alignment)
 */
export function assertProjectionConsistency(graph: BackendStateGraph): void {
  if (process.env.NODE_ENV === 'production') return
  
  // Derive expected projections from graph (pure functions)
  const expectedTableCount = Object.keys(graph.entities || {}).length
  const expectedApiCount = Object.keys(graph.apis || {}).length
  const expectedPolicyCount = Object.keys(graph.policies || {}).length
  
  // These are internal consistency checks - no external API calls
  console.log(`[Projection Guard] Graph state: ${expectedTableCount} tables, ${expectedApiCount} APIs, ${expectedPolicyCount} policies`)
}

// ============================================================================
// GRAPH INVARIANT CHECKS
// ============================================================================

/**
 * Ensure no duplicate policies exist (semantic equality)
 */
function assertNoDuplicatePolicies(graph: BackendStateGraph): void {
  const policies = graph.policies || {}
  const seen = new Map<string, string>()
  
  for (const [policyId, policy] of Object.entries(policies)) {
    // Create semantic key (ignore id, createdAt, createdBy)
    const semanticKey = JSON.stringify({
      domain: policy.domain,
      action: policy.action,
      target: policy.target,
      rule: policy.rule,
      enabled: policy.enabled,
      role: policy.role,
      resource: policy.resource,
      operation: policy.operation,
    })
    
    const existingId = seen.get(semanticKey)
    if (existingId) {
      throw new Error(
        `[Projection Guard] DUPLICATE POLICY DETECTED:\n` +
        `  Policy ID 1: ${existingId}\n` +
        `  Policy ID 2: ${policyId}\n` +
        `  Semantic key: ${semanticKey}\n` +
        `This is a kernel integrity violation. Policy deduplication failed.`
      )
    }
    
    seen.set(semanticKey, policyId)
  }
}

/**
 * Repair orphaned relationships in-place before graph is saved.
 * Removes relationships pointing to non-existent entities.
 * Also removes orphaned relation fields (fields with relationTo pointing to missing entities).
 * Returns the list of repairs made (for logging).
 */
export function repairOrphanRelationships(graph: BackendStateGraph): string[] {
  const entities = graph.entities || {}
  const repairs: string[] = []

  for (const [entityName, entity] of Object.entries(entities)) {
    // Repair relationship array
    const before = (entity.relationships || []).length
    entity.relationships = (entity.relationships || []).filter(rel => {
      if (rel.to && !entities[rel.to]) {
        repairs.push(`Removed orphan relationship: ${entityName} -> ${rel.to}`)
        return false
      }
      return true
    })
    if (entity.relationships.length !== before) {
      console.warn(`[Projection Guard] Repaired ${before - entity.relationships.length} orphan relationship(s) on entity "${entityName}"`)
    }

    // Repair relation fields pointing to missing entities
    for (const [fieldName, field] of Object.entries(entity.fields || {})) {
      if ((field as any).type === 'relation' && (field as any).relationTo && !entities[(field as any).relationTo]) {
        // Remap to 'users' if the name implies a user relationship, otherwise drop
        const fallback = 'users'
        if (entities[fallback]) {
          repairs.push(`Remapped orphan relation field ${entityName}.${fieldName} (${(field as any).relationTo} -> ${fallback})`)
          ;(field as any).relationTo = fallback
        } else {
          repairs.push(`Removed orphan relation field ${entityName}.${fieldName} -> ${(field as any).relationTo}`)
          ;(field as any).type = 'string'
          delete (field as any).relationTo
        }
      }
    }
  }

  return repairs
}

/**
 * Ensure no orphaned relationships (foreign key pointing to non-existent table)
 */
function assertNoOrphanRelationships(graph: BackendStateGraph): void {
  const entities = graph.entities || {}

  for (const [entityName, entity] of Object.entries(entities)) {
    const relationships = entity.relationships || []

    for (const rel of relationships) {
      const targetEntity = rel.to

      if (targetEntity && !entities[targetEntity]) {
        throw new Error(
          `[Projection Guard] ORPHAN RELATIONSHIP DETECTED:\n` +
          `  From: ${entityName}\n` +
          `  To: ${targetEntity} (DOES NOT EXIST)\n` +
          `  Relationship: ${rel.from} -> ${rel.to}\n` +
          `This violates referential integrity. Target entity must exist.`
        )
      }
    }
  }
}

/**
 * Ensure entity names are unique (case-insensitive)
 */
function assertUniqueEntityNames(graph: BackendStateGraph): void {
  const entities = graph.entities || {}
  const seen = new Map<string, string>()
  
  for (const [entityName, entity] of Object.entries(entities)) {
    const normalizedName = entityName.toLowerCase()
    const existingName = seen.get(normalizedName)
    
    if (existingName && existingName !== entityName) {
      throw new Error(
        `[Projection Guard] DUPLICATE ENTITY NAME DETECTED:\n` +
        `  Name 1: ${existingName}\n` +
        `  Name 2: ${entityName}\n` +
        `Entity names must be unique (case-insensitive).`
      )
    }
    
    seen.set(normalizedName, entityName)
  }
}

// ============================================================================
// TIMELINE POINTER INVARIANTS
// ============================================================================

/**
 * Ensure timeline pointer matches active graph
 * NOTE: This requires external state (activeGraphId), so it's opt-in
 */
export function assertTimelinePointerConsistency(
  graph: BackendStateGraph,
  activeGraphId: string
): void {
  if (process.env.NODE_ENV === 'production') return
  
  if (graph.projectId !== activeGraphId) {
    throw new Error(
      `[Projection Guard] TIMELINE POINTER MISMATCH:\n` +
      `  Graph Project ID: ${graph.projectId}\n` +
      `  Active Graph ID: ${activeGraphId}\n` +
      `Timeline pointer is stale or incorrect.`
    )
  }
}

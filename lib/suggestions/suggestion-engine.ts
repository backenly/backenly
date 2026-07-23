/**
 * Backenly Suggestion Engine
 * 
 * A non-mutating, graph-observational advisory layer.
 * Like a senior backend engineer reviewing your schema in real-time.
 * 
 * PRINCIPLES:
 * - Never mutates state
 * - Never bypasses validators
 * - Never auto-executes
 * - Deterministic rule-based analysis
 * - Project-scoped and graph-version-aware
 */

import { BackendStateGraph, EntityState, RelationshipState } from '@/lib/orchestration/backend-state-graph'

export interface Suggestion {
  id: string
  type: 'performance' | 'security' | 'schema' | 'architecture' | 'scaling'
  severity: 'low' | 'medium' | 'high'
  message: string
  rationale: string
  suggestedPrompt?: string
  createdAt: Date
}

export interface SuggestionContext {
  projectId: string
  graphId: string
  graph: BackendStateGraph
  timestamp: Date
}

// ============================================================================
// DETERMINISTIC RULE ENGINE
// ============================================================================

/**
 * Generate suggestions from graph analysis
 * 
 * CRITICAL: Must complete in < 20ms
 * No OpenAI calls. No randomness. Pure rule-based.
 */
export async function generateSuggestions(
  projectId: string,
  graph: BackendStateGraph
): Promise<Suggestion[]> {
  const startTime = Date.now()
  const suggestions: Suggestion[] = []
  
  // Run all analyzers
  suggestions.push(...analyzeSchemaPatterns(graph))
  suggestions.push(...analyzeAuthPatterns(graph))
  suggestions.push(...analyzeApiPatterns(graph))
  suggestions.push(...analyzeStoragePatterns(graph))
  suggestions.push(...analyzeScalingSignals(graph))
  suggestions.push(...analyzeSecuritySignals(graph))
  
  const duration = Date.now() - startTime
  console.log(`[Suggestion Engine] Generated ${suggestions.length} suggestions in ${duration}ms`)
  
  return suggestions.sort((a, b) => severityWeight(b.severity) - severityWeight(a.severity))
}

function severityWeight(severity: string): number {
  const weights = { high: 3, medium: 2, low: 1 }
  return weights[severity] || 0
}

// ============================================================================
// 1️⃣ SCHEMA PATTERNS
// ============================================================================

function analyzeSchemaPatterns(graph: BackendStateGraph): Suggestion[] {
  const suggestions: Suggestion[] = []
  const entities = Object.values(graph.entities)
  
  for (const entity of entities) {
    // Rule: Table without index on foreign key
    // TEMPORARILY DISABLED: Type mismatch with RelationshipState
    // TODO: Re-implement foreign key index suggestions
    /*
    const foreignKeys = entity.relationships.filter(r => r.type === 'one-to-many')
    for (const fk of foreignKeys) {
      if (fk.foreignKey && !hasIndex(entity, fk.foreignKey)) {
        suggestions.push({
          id: `idx-${entity.name}-${fk.foreignKey}`,
          type: 'performance',
          severity: 'medium',
          message: `${entity.name}.${fk.foreignKey} should have an index`,
          rationale: `Foreign key columns are frequently used in JOIN queries. Without an index, queries slow down as data grows.`,
          suggestedPrompt: `Add index on ${entity.name}.${fk.foreignKey}`,
          createdAt: new Date(),
        })
      }
    }
    */
    
    // Rule: Table with > 15 fields → suggest normalization
    const fieldCount = Object.keys(entity.fields).length
    if (fieldCount > 15) {
      suggestions.push({
        id: `norm-${entity.name}`,
        type: 'schema',
        severity: 'low',
        message: `${entity.name} has ${fieldCount} fields — consider normalization`,
        rationale: `Wide tables become hard to maintain and query efficiently. Consider splitting into related entities.`,
        suggestedPrompt: `Normalize ${entity.name} into smaller related tables`,
        createdAt: new Date(),
      })
    }
    
    // Rule: Missing unique constraint on email-like fields
    const emailField = Object.entries(entity.fields).find(([name, field]) => 
      name.toLowerCase().includes('email') && 
      !field.unique
    )
    if (emailField) {
      suggestions.push({
        id: `unique-${entity.name}-${emailField[0]}`,
        type: 'security',
        severity: 'high',
        message: `${entity.name}.${emailField[0]} should be unique`,
        rationale: `Email fields typically represent unique user identifiers. Without a unique constraint, duplicate accounts can be created.`,
        suggestedPrompt: `Add unique constraint on ${entity.name}.${emailField[0]}`,
        createdAt: new Date(),
      })
    }
    
    // Rule: No createdAt/updatedAt audit fields
    const hasCreatedAt = entity.fields.createdAt || entity.fields.created_at
    const hasUpdatedAt = entity.fields.updatedAt || entity.fields.updated_at
    if (!hasCreatedAt || !hasUpdatedAt) {
      suggestions.push({
        id: `audit-${entity.name}`,
        type: 'schema',
        severity: 'low',
        message: `${entity.name} missing audit timestamps`,
        rationale: `createdAt and updatedAt fields are essential for debugging, analytics, and data lineage tracking.`,
        suggestedPrompt: `Add createdAt and updatedAt to ${entity.name}`,
        createdAt: new Date(),
      })
    }
  }
  
  return suggestions
}

function hasIndex(entity: EntityState, fieldName: string): boolean {
  // Check if field is marked as indexed
  // Note: FieldState doesn't have indexed property, check unique instead
  const field = entity.fields[fieldName]
  return field?.unique === true
}

// ============================================================================
// 2️⃣ AUTH PATTERNS
// ============================================================================

function analyzeAuthPatterns(graph: BackendStateGraph): Suggestion[] {
  const suggestions: Suggestion[] = []
  const auth = graph.auth
  
  // Check if auth is enabled by checking if any providers are configured
  const hasProviders = auth?.providers && Object.keys(auth.providers).length > 0
  if (!hasProviders) return suggestions
  
  // Rule: Auth enabled but no role system
  const hasRolesTable = graph.entities.roles || graph.entities.role
  const hasUserRoles = graph.entities.userRoles || graph.entities.user_roles
  if (!hasRolesTable && !hasUserRoles) {
    suggestions.push({
      id: 'auth-rbac',
      type: 'security',
      severity: 'medium',
      message: 'Consider adding a role-based access control system',
      rationale: `Authentication without authorization leads to security gaps. Roles enable permission-based access control.`,
      suggestedPrompt: 'Add roles and permissions system with admin and user roles',
      createdAt: new Date(),
    })
  }
  
  // Rule: Admin flag without proper roles table
  for (const [name, entity] of Object.entries(graph.entities)) {
    const hasAdminFlag = entity.fields.isAdmin || entity.fields.is_admin || entity.fields.admin
    if (hasAdminFlag && !hasRolesTable) {
      suggestions.push({
        id: `auth-admin-${name}`,
        type: 'architecture',
        severity: 'medium',
        message: `${name} has admin flag — consider proper RBAC instead`,
        rationale: `Boolean admin flags don't scale. A roles table with permissions is more flexible and maintainable.`,
        suggestedPrompt: `Replace ${name}.isAdmin with a roles table`,
        createdAt: new Date(),
      })
    }
  }
  
  
  // Note: OAuth callback URLs are configured via environment variables, not in graph state
  
  return suggestions
}

// ============================================================================
// 3️⃣ API DESIGN PATTERNS
// ============================================================================

function analyzeApiPatterns(graph: BackendStateGraph): Suggestion[] {
  const suggestions: Suggestion[] = []
  const apis = Object.values(graph.apis)
  
  // Rule: Public write endpoints without auth
  const publicWriteApis = apis.filter(api => {
    const hasWriteMethod = api.methods?.some(m => 
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(m)
    )
    const isPublic = !api.requiresAuth // ApiState has requiresAuth boolean
    return hasWriteMethod && isPublic
  })
  
  for (const api of publicWriteApis) {
    suggestions.push({
      id: `api-public-write-${api.path}`,
      type: 'security',
      severity: 'high',
      message: `Public write endpoint detected: ${api.path}`,
      rationale: `Write endpoints without authentication allow anyone to modify your data. This is a critical security risk.`,
      suggestedPrompt: `Add authentication to ${api.path}`,
      createdAt: new Date(),
    })
  }
  
  // Rule: Too many GET endpoints without pagination
  // Note: Current ApiState doesn't track pagination - this would need to be added to graph model
  const listEndpoints = apis.filter(api => 
    api.methods?.includes('GET') && 
    !api.path.includes(':id')
  )
  
  if (listEndpoints.length > 3) {
    suggestions.push({
      id: 'api-pagination',
      type: 'performance',
      severity: 'medium',
      message: 'Multiple list endpoints without pagination',
      rationale: `List endpoints without pagination will become slow as data grows. Consider adding limit/offset or cursor-based pagination.`,
      suggestedPrompt: 'Add pagination to list endpoints',
      createdAt: new Date(),
    })
  }
  
  // Rule: No rate limiting capability
  // Check if rateLimiting capability exists and is active
  const hasRateLimiting = graph.capabilities && 
    Object.values(graph.capabilities).some(cap => cap.type === 'rateLimiting' && cap.status === 'active')
  
  if (!hasRateLimiting) {
    const hasPublicEndpoints = apis.some(api => !api.requiresAuth)
    if (hasPublicEndpoints) {
      suggestions.push({
        id: 'api-rate-limit',
        type: 'security',
        severity: 'medium',
        message: 'Consider enabling rate limiting',
        rationale: `Public APIs without rate limiting are vulnerable to abuse and denial-of-service attacks.`,
        suggestedPrompt: 'Enable rate limiting for public APIs',
        createdAt: new Date(),
      })
    }
  }
  
  return suggestions
}

// ============================================================================
// 4️⃣ STORAGE PATTERNS
// ============================================================================

function analyzeStoragePatterns(graph: BackendStateGraph): Suggestion[] {
  const suggestions: Suggestion[] = []
  const storage = graph.storage
  
  // Check if storage has any buckets configured
  if (!storage || !storage.buckets || Object.keys(storage.buckets).length === 0) {
    return suggestions
  }
  
  // Rule: File upload enabled but no size limit
  for (const [bucketName, bucket] of Object.entries(storage.buckets)) {
    if (!bucket.maxFileSize) {
      suggestions.push({
        id: `storage-quota-${bucketName}`,
        type: 'security',
        severity: 'medium',
        message: `${bucketName} bucket has no size limit`,
        rationale: `Unlimited file uploads can lead to storage abuse and unexpected costs. Set a reasonable maximum file size.`,
        suggestedPrompt: `Add file size limit to ${bucketName} bucket`,
        createdAt: new Date(),
      })
    }
  }
  
  // Note: Current StorageState doesn't track retention policies or lifecycle rules
  // These would need to be added to the graph model for lifecycle suggestions
  
  return suggestions
}

// ============================================================================
// 5️⃣ SCALING SIGNALS
// ============================================================================

function analyzeScalingSignals(graph: BackendStateGraph): Suggestion[] {
  const suggestions: Suggestion[] = []
  const entityCount = Object.keys(graph.entities).length
  
  // Rule: More than 10 tables → suggest read replicas later
  if (entityCount > 10) {
    suggestions.push({
      id: 'scaling-read-replicas',
      type: 'scaling',
      severity: 'low',
      message: 'Consider read replicas for high-traffic workloads',
      rationale: `With ${entityCount} tables, your database may benefit from read replicas to distribute query load as you scale.`,
      suggestedPrompt: 'Plan for database read replicas',
      createdAt: new Date(),
    })
  }
  
  // Rule: Heavy relational chains → suggest caching
  const deepRelationships = countDeepRelationships(graph)
  if (deepRelationships > 5) {
    suggestions.push({
      id: 'scaling-cache',
      type: 'performance',
      severity: 'low',
      message: 'Consider caching for complex relationship queries',
      rationale: `Deep relationship chains (found ${deepRelationships}) can slow down queries. Caching frequently accessed data improves performance.`,
      suggestedPrompt: 'Add caching for frequently queried data',
      createdAt: new Date(),
    })
  }
  
  return suggestions
}

function countDeepRelationships(graph: BackendStateGraph): number {
  let count = 0
  for (const entity of Object.values(graph.entities)) {
    for (const rel of entity.relationships) {
      // Count relationships that traverse more than one hop
      const targetEntity = graph.entities[rel.to]
      if (targetEntity && targetEntity.relationships.length > 0) {
        count++
      }
    }
  }
  return count
}

// ============================================================================
// 6️⃣ SECURITY SIGNALS
// ============================================================================

function analyzeSecuritySignals(graph: BackendStateGraph): Suggestion[] {
  const suggestions: Suggestion[] = []
  
  // Note: OAuth secrets are configured via environment variables, not tracked in graph state
  // Provider config only tracks enabled/disabled status
  
  // Rule: Webhook with auth but no secretRef
  for (const [name, webhook] of Object.entries(graph.webhooks || {})) {
    if (webhook.auth?.type && !webhook.auth.secretRef) {
      suggestions.push({
        id: `sec-webhook-${name}`,
        type: 'security',
        severity: 'high',
        message: `Webhook ${name} auth missing secretRef`,
        rationale: `Webhook authentication should use secretRef, not raw secrets. This ensures secure credential management.`,
        suggestedPrompt: `Use secretRef for ${name} webhook authentication`,
        createdAt: new Date(),
      })
    }
  }
  
  // Rule: Billing enabled but webhook secret not configured
  if (graph.billing?.enabled && !graph.billing.webhooks?.secretRef) {
    suggestions.push({
      id: 'sec-billing-webhook',
      type: 'security',
      severity: 'high',
      message: 'Billing webhooks missing secret reference',
      rationale: `Payment webhooks must be verified with a secret to prevent spoofing attacks. Configure webhook secret as secretRef.`,
      suggestedPrompt: 'Configure Stripe webhook secret as secretRef',
      createdAt: new Date(),
    })
  }
  
  return suggestions
}

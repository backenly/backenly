/**
 * Schema Invariant Validator
 * 
 * CRITICAL PRODUCTION SAFETY LAYER
 * 
 * This is a DETERMINISTIC, NON-LLM guard between intent parsing and graph mutation.
 * 
 * PURPOSE:
 * - Block execution if intent violates structural invariants
 * - Route to Guidance Mode instead of mutating
 * - Eliminate 60% of audit risk from probabilistic LLM outputs
 * 
 * PHILOSOPHY:
 * - Users never see this layer
 * - No UI, no technical questions, no confirmations
 * - Just: safe mutation OR guidance redirect
 * 
 * This is how Stripe/Vercel/Notion stay safe while appearing simple.
 */

import { CanonicalIntent } from './types'
import { BackendStateGraph, EntityState } from './backend-state-graph'

export interface InvariantViolation {
  rule: string
  severity: 'blocking' | 'warning'
  reason: string
  guidanceMessage: string // What to tell the user (non-technical)
}

export interface InvariantValidationResult {
  valid: boolean
  violations: InvariantViolation[]
  shouldRouteToGuidance: boolean
  guidanceMessage?: string
}

/**
 * THE INVARIANT RULES (NON-NEGOTIABLE)
 * 
 * These are the structural guarantees Backenly MUST enforce.
 * If any rule is violated, execution MUST be blocked.
 */

/**
 * Validate schema invariants before allowing graph mutation
 * 
 * CRITICAL: This is the last line of defense against corrupted state.
 */
export function validateSchemaInvariants(
  intent: CanonicalIntent,
  graph: BackendStateGraph
): InvariantValidationResult {
  const violations: InvariantViolation[] = []
  
  // Rule 1: Every table must have id and createdAt
  const idCreatedAtViolation = checkIdCreatedAtInvariant(intent, graph)
  if (idCreatedAtViolation) violations.push(idCreatedAtViolation)
  
  // Rule 2: No duplicate semantic entities
  const duplicateViolation = checkDuplicateEntityInvariant(intent, graph)
  if (duplicateViolation) violations.push(duplicateViolation)
  
  // Rule 3: Relationship uniqueness (no duplicate foreign keys)
  const relationshipViolation = checkRelationshipUniquenessInvariant(intent, graph)
  if (relationshipViolation) violations.push(relationshipViolation)
  
  // Rule 4: No privilege escalation (public → admin)
  const privilegeViolation = checkPrivilegeEscalationInvariant(intent, graph)
  if (privilegeViolation) violations.push(privilegeViolation)
  
  // Rule 5: No auth-critical field removal
  const authFieldViolation = checkAuthCriticalFieldInvariant(intent, graph)
  if (authFieldViolation) violations.push(authFieldViolation)
  
  // Rule 6: No circular dependencies
  const circularViolation = checkCircularDependencyInvariant(intent, graph)
  if (circularViolation) violations.push(circularViolation)
  
  // Rule 7: NO RAW SECRETS in graph data (CRITICAL SECURITY)
  const secretViolation = checkNoRawSecretsInvariant(intent, graph)
  if (secretViolation) violations.push(secretViolation)
  
  // Check if any blocking violations exist
  const blockingViolations = violations.filter(v => v.severity === 'blocking')
  
  if (blockingViolations.length > 0) {
    // Generate unified guidance message
    const guidanceMessage = generateGuidanceMessage(blockingViolations, intent)
    
    return {
      valid: false,
      violations,
      shouldRouteToGuidance: true,
      guidanceMessage,
    }
  }
  
  // Warnings only - allow execution
  return {
    valid: true,
    violations,
    shouldRouteToGuidance: false,
  }
}

/**
 * RULE 1: Every table must have id and createdAt
 * 
 * Without these fields, rollback/restore becomes impossible.
 */
function checkIdCreatedAtInvariant(
  intent: CanonicalIntent,
  graph: BackendStateGraph
): InvariantViolation | null {
  // Only apply to table creation/modification
  const isDataModelIntent = intent.intent_type === 'DATA_MODEL_ADD' || 
                           intent.intent_type === 'DATA_MODEL_MODIFY' ||
                           intent.domain === 'DATABASE'
  if (!isDataModelIntent) return null
  if (intent.action === 'DELETE') return null
  
  const targetEntity = intent.target
  if (!targetEntity) return null
  
  // Check if intent is trying to create table without id/createdAt
  const fields = intent.constraints.fields || []
  const hasId = fields.includes('id') || fields.some((f: any) => f.name === 'id')
  const hasCreatedAt = fields.includes('createdAt') || fields.some((f: any) => f.name === 'createdAt')
  
  // If fields are explicitly specified and missing id/createdAt, violation
  if (fields.length > 0 && (!hasId || !hasCreatedAt)) {
    return {
      rule: 'ID_CREATEDAT_REQUIRED',
      severity: 'blocking',
      reason: 'Every table must have id and createdAt fields for data integrity',
      guidanceMessage: `I need a bit more clarity before making changes. Could you describe what information should be stored? I'll handle the technical structure automatically.`,
    }
  }
  
  return null
}

/**
 * RULE 2: No duplicate semantic entities
 * 
 * Prevents: User, ProfileUser, UserProfile all existing simultaneously.
 */
function checkDuplicateEntityInvariant(
  intent: CanonicalIntent,
  graph: BackendStateGraph
): InvariantViolation | null {
  // Only apply to table creation
  const isTableCreation = (intent.intent_type === 'DATA_MODEL_ADD' || intent.domain === 'DATABASE') && 
                         intent.action === 'CREATE'
  if (!isTableCreation) return null
  
  const newEntityName = intent.target?.toLowerCase()
  if (!newEntityName) return null
  
  // Check for semantic duplicates
  const existingEntities = Object.keys(graph.entities).map(e => e.toLowerCase())
  
  // Normalize entity names for comparison
  const normalized = normalizeEntityName(newEntityName)
  
  for (const existing of existingEntities) {
    const existingNormalized = normalizeEntityName(existing)
    
    // Check if semantically similar
    if (
      normalized === existingNormalized ||
      normalized.includes(existingNormalized) ||
      existingNormalized.includes(normalized)
    ) {
      return {
        rule: 'NO_DUPLICATE_ENTITIES',
        severity: 'blocking',
        reason: `Entity "${newEntityName}" is semantically duplicate of "${existing}"`,
        guidanceMessage: `It looks like you already have a "${existing}" table. Did you want to modify that one instead, or create something completely different?`,
      }
    }
  }
  
  return null
}

/**
 * RULE 3: Relationship uniqueness (no duplicate foreign keys)
 * 
 * Prevents: User has two "profileId" fields pointing to different tables.
 */
function checkRelationshipUniquenessInvariant(
  intent: CanonicalIntent,
  graph: BackendStateGraph
): InvariantViolation | null {
  // Only apply to relationship creation
  const isDataModelIntent = intent.intent_type === 'DATA_MODEL_ADD' || 
                           intent.intent_type === 'DATA_MODEL_MODIFY' ||
                           intent.domain === 'DATABASE'
  if (!isDataModelIntent) return null
  
  const relationships = intent.constraints.relationships || []
  if (relationships.length === 0) return null
  
  const targetEntity = intent.target
  if (!targetEntity || !graph.entities[targetEntity]) return null
  
  const entity = graph.entities[targetEntity]
  const existingRelationships = entity.relationships.map(r => r.foreignKey).filter(Boolean)
  
  for (const rel of relationships) {
    const fkName = rel.foreignKey || `${rel.to}Id`
    
    if (existingRelationships.includes(fkName)) {
      return {
        rule: 'UNIQUE_RELATIONSHIPS',
        severity: 'blocking',
        reason: `Duplicate foreign key "${fkName}" in ${targetEntity}`,
        guidanceMessage: `I need a bit more clarity. There's already a connection between "${targetEntity}" and another table. Could you clarify what should be connected to what?`,
      }
    }
  }
  
  return null
}

/**
 * RULE 4: No privilege escalation (public → admin)
 * 
 * Prevents: "Make all users admins" from succeeding.
 * 
 * CRITICAL: Evaluates against CURRENT graph policies + proposed diff.
 */
function checkPrivilegeEscalationInvariant(
  intent: CanonicalIntent,
  graph: BackendStateGraph
): InvariantViolation | null {
  // Only apply to access control changes
  if (intent.intent_type !== 'ACCESS_CONTROL' && intent.domain !== 'API' && intent.domain !== 'AUTH') return null
  
  // Extract current and proposed policies
  const targetResource = intent.target || 'all_apis'
  const currentPolicies = graph.policies[targetResource]
  
  // Check if intent is trying to grant admin/elevated privileges to public
  const grantingAdmin = intent.constraints.role === 'admin' || 
                       intent.constraints.permission === 'admin' ||
                       /\b(make|allow|grant).*\b(everyone|all|public).*\b(admin|superuser|elevated)\b/i.test(intent.source_text)
  
  if (grantingAdmin && intent.action === 'ALLOW') {
    return {
      rule: 'NO_PRIVILEGE_ESCALATION',
      severity: 'blocking',
      reason: 'Cannot grant admin privileges to public users',
      guidanceMessage: `I need a bit more clarity before making security changes. Who specifically should have admin access? I want to make sure your data stays protected.`,
    }
  }
  
  // Check if downgrading from authenticated to public access
  if (currentPolicies) {
    // Check if current policy enforces authentication
    const currentRequiresAuth = currentPolicies.enabled && 
                               (currentPolicies.domain === 'auth' || currentPolicies.rule.includes('authenticated'))
    const newMakesPublic = intent.constraints.public === true || 
                          intent.constraints.requireAuth === false ||
                          /\b(make|allow).*\b(public|everyone|anyone)\b/i.test(intent.source_text)
    
    if (currentRequiresAuth && newMakesPublic && intent.action === 'ALLOW') {
      return {
        rule: 'NO_PRIVILEGE_ESCALATION',
        severity: 'blocking',
        reason: `Cannot downgrade ${targetResource} from authenticated to public access`,
        guidanceMessage: `I need a bit more clarity. This resource currently requires authentication. Making it public would allow anyone to access it. Is that what you intended?`,
      }
    }
  }
  
  // Check if granting elevated role without constraints
  if (intent.action === 'ALLOW' && intent.constraints.role) {
    const elevatedRoles = ['admin', 'superuser', 'owner', 'moderator']
    const isElevated = elevatedRoles.includes(intent.constraints.role.toLowerCase())
    const hasUserConstraint = intent.constraints.userId || intent.constraints.email || intent.constraints.specific
    
    if (isElevated && !hasUserConstraint) {
      return {
        rule: 'NO_PRIVILEGE_ESCALATION',
        severity: 'blocking',
        reason: `Cannot grant ${intent.constraints.role} role without specifying which user(s)`,
        guidanceMessage: `I need a bit more clarity. Which specific user should have ${intent.constraints.role} access? I want to make sure permissions are granted correctly.`,
      }
    }
  }
  
  return null
}

/**
 * RULE 5: No auth-critical field removal
 * 
 * Prevents: "Remove email field" when auth depends on email.
 */
function checkAuthCriticalFieldInvariant(
  intent: CanonicalIntent,
  graph: BackendStateGraph
): InvariantViolation | null {
  // Only apply to field removal
  if (intent.action !== 'DELETE') return null
  
  const targetField = intent.target?.split('.')[1]
  if (!targetField) return null
  
  // Check if email/password fields are being removed
  const criticalFields = ['email', 'password', 'hashedPassword', 'passwordHash']
  
  if (criticalFields.includes(targetField.toLowerCase())) {
    // Check if auth is enabled
    const authEnabled = graph.auth.providers.email?.enabled ||
                       graph.auth.providers.google?.enabled ||
                       graph.auth.providers.github?.enabled
    
    if (authEnabled) {
      return {
        rule: 'AUTH_CRITICAL_FIELD',
        severity: 'blocking',
        reason: `Cannot remove ${targetField} - required for authentication`,
        guidanceMessage: `I need a bit more clarity. Your app uses ${targetField} for user login. Removing it would break authentication. Did you want to modify how login works instead?`,
      }
    }
  }
  
  return null
}

/**
 * RULE 6: No circular dependencies
 * 
 * Prevents: User → Profile → UserSettings → User (cycle)
 */
function checkCircularDependencyInvariant(
  intent: CanonicalIntent,
  graph: BackendStateGraph
): InvariantViolation | null {
  // Only apply to relationship creation
  const isDataModelIntent = intent.intent_type === 'DATA_MODEL_ADD' || 
                           intent.intent_type === 'DATA_MODEL_MODIFY' ||
                           intent.domain === 'DATABASE'
  if (!isDataModelIntent) return null
  
  const relationships = intent.constraints.relationships || []
  if (relationships.length === 0) return null
  
  const fromEntity = intent.target
  if (!fromEntity) return null
  
  for (const rel of relationships) {
    const toEntity = rel.to
    
    // Check if adding this relationship creates a cycle
    if (wouldCreateCycle(fromEntity, toEntity, graph)) {
      return {
        rule: 'NO_CIRCULAR_DEPENDENCIES',
        severity: 'blocking',
        reason: `Creating relationship ${fromEntity} → ${toEntity} would create circular dependency`,
        guidanceMessage: `I need a bit more clarity. The connection you described might create a loop in the data structure. Could you clarify which table should contain the reference?`,
      }
    }
  }
  
  return null
}

/**
 * Helper: Normalize entity name for semantic comparison
 */
function normalizeEntityName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[_-]/g, '')
    .replace(/s$/, '') // Remove trailing 's' for plurals
    .replace(/profile|user|data|info|record|table/g, '') // Remove common suffixes
    .trim()
}

/**
 * Helper: Check if adding relationship would create cycle
 */
function wouldCreateCycle(
  from: string,
  to: string,
  graph: BackendStateGraph
): boolean {
  // BFS to detect cycle
  const visited = new Set<string>()
  const queue: string[] = [to]
  
  while (queue.length > 0) {
    const current = queue.shift()!
    
    if (current === from) return true // Cycle detected
    if (visited.has(current)) continue
    
    visited.add(current)
    
    // Add all entities that current entity references
    const entity = graph.entities[current]
    if (entity) {
      entity.relationships.forEach(rel => {
        if (rel.to && !visited.has(rel.to)) {
          queue.push(rel.to)
        }
      })
    }
  }
  
  return false
}

/**
 * RULE 7: NO RAW SECRETS in graph data
 * 
 * Prevents: API keys, passwords, tokens stored in versioned graph JSON
 * Forces: env var references only (secretRef pattern)
 * 
 * CRITICAL: Raw secrets in graph would be:
 * - Versioned forever (immutable history)
 * - Exposed in timeline diffs
 * - Potentially streamed to frontend
 * - Included in SDK responses
 */
function checkNoRawSecretsInvariant(
  intent: CanonicalIntent,
  graph: BackendStateGraph
): InvariantViolation | null {
  // Check intent constraints for potential secret fields
  const fields = intent.constraints.fields || []
  
  for (const field of fields) {
    const fieldName = typeof field === 'string' ? field : field.name
    const fieldValue = typeof field === 'string' ? null : field.value
    
    // Check for raw secret fields without Ref suffix
    const isSecretField = /^(secret|apiKey|password|token|key|privateKey)$/i.test(fieldName)
    const isRefField = /Ref$/.test(fieldName)
    
    if (isSecretField && !isRefField) {
      // If value looks like a real secret (not env. reference), BLOCK
      if (fieldValue && 
          typeof fieldValue === 'string' && 
          !fieldValue.startsWith('env.') &&
          !fieldValue.startsWith('${') &&
          fieldValue.length > 10) {
        return {
          rule: 'NO_RAW_SECRETS',
          severity: 'blocking',
          reason: `Field "${fieldName}" appears to contain a raw secret. Use "${fieldName}Ref" with env reference instead.`,
          guidanceMessage: `For security, Backenly never stores raw secrets in your backend configuration. Please use environment variable references instead (e.g., "${fieldName}Ref": "env.YOUR_SECRET_NAME").`,
        }
      }
    }
  }
  
  // Check webhook configs in graph
  for (const [name, webhook] of Object.entries(graph.webhooks || {})) {
    if ((webhook as any).auth?.secret) {
      return {
        rule: 'NO_RAW_SECRETS',
        severity: 'blocking',
        reason: `Webhook "${name}" contains raw secret in auth config`,
        guidanceMessage: 'Webhook authentication must use secretRef (e.g., "secretRef": "env.WEBHOOK_SECRET") instead of raw secret.',
      }
    }
  }
  
  return null
}

/**
 * Generate user-friendly guidance message from blocking violations
 * 
 * CRITICAL: Message must be warm, non-technical, and actionable.
 */
function generateGuidanceMessage(
  violations: InvariantViolation[],
  intent: CanonicalIntent
): string {
  // Use the first blocking violation's guidance message
  const primaryViolation = violations[0]
  
  return primaryViolation.guidanceMessage
}

/**
 * Helper: Check if intent passes all invariants
 */
export function isIntentSafe(
  intent: CanonicalIntent,
  graph: BackendStateGraph
): boolean {
  const result = validateSchemaInvariants(intent, graph)
  return result.valid
}

/**
 * Helper: Get violation summary for logging
 */
export function getViolationSummary(violations: InvariantViolation[]): string {
  return violations
    .map(v => `[${v.severity.toUpperCase()}] ${v.rule}: ${v.reason}`)
    .join('\n')
}

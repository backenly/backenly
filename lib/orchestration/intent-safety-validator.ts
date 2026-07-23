/**
 * Phase 3: Intent Safety Validator
 * 
 * Prevents silent disasters by validating intents before execution.
 * AI is ALLOWED to override unsafe user intent.
 * 
 * This is Backenly's safety moat - we say NO when necessary.
 */

import { CanonicalIntent } from './types'
import { BackendStateGraph, findReason, findDependencies } from './backend-state-graph'

export interface SafetyValidationResult {
  safe: boolean
  violations: SafetyViolation[]
  safeAlternative?: CanonicalIntent
  userMessage: string // Human-readable explanation
}

export interface SafetyViolation {
  type: ViolationType
  severity: 'blocking' | 'warning' | 'info'
  target: string
  reason: string
  impact: string[]
}

export type ViolationType =
  | 'DATA_LOSS'
  | 'AUTH_BREACH'
  | 'BREAKING_CHANGE'
  | 'SECURITY_DOWNGRADE'
  | 'AMBIGUOUS_INTENT'
  | 'CIRCULAR_DEPENDENCY'
  | 'PERFORMANCE_RISK'

/**
 * Validate intent against backend state
 * 
 * CRITICAL: This can REJECT or MODIFY user intent
 */
export async function validateIntentSafety(
  intent: CanonicalIntent,
  graph: BackendStateGraph
): Promise<SafetyValidationResult> {
  const violations: SafetyViolation[] = []

  // Rule 1: Prevent auth field removal
  if (intent.intent_type === 'FEATURE_REMOVE' || intent.action === 'DELETE') {
    const authViolation = checkAuthInvariant(intent, graph)
    if (authViolation) violations.push(authViolation)
  }

  // Rule 2: Prevent data loss
  if (intent.action === 'DELETE' || intent.action === 'DISABLE') {
    const dataLossViolation = checkDataLoss(intent, graph)
    if (dataLossViolation) violations.push(dataLossViolation)
  }

  // Rule 3: Prevent security downgrade
  if (intent.intent_type === 'ACCESS_CONTROL' && intent.action === 'ALLOW') {
    const securityViolation = checkSecurityDowngrade(intent, graph)
    if (securityViolation) violations.push(securityViolation)
  }

  // Rule 4: Check for breaking changes
  const breakingViolation = checkBreakingChanges(intent, graph)
  if (breakingViolation) violations.push(breakingViolation)

  // Rule 5: Detect ambiguous intent
  if (intent.confidence < 0.7) {
    violations.push({
      type: 'AMBIGUOUS_INTENT',
      severity: 'warning',
      target: intent.source_text,
      reason: 'Intent is not clear enough',
      impact: ['May produce unexpected results'],
    })
  }

  // Check if any blocking violations exist
  const blockingViolations = violations.filter(v => v.severity === 'blocking')

  if (blockingViolations.length > 0) {
    // Generate safe alternative
    const safeAlternative = generateSafeAlternative(intent, blockingViolations, graph)
    
    return {
      safe: false,
      violations,
      safeAlternative,
      userMessage: generateUserMessage(blockingViolations, safeAlternative),
    }
  }

  // Warnings only - proceed with caution
  if (violations.length > 0) {
    return {
      safe: true,
      violations,
      userMessage: `Proceeding with ${violations.length} warning(s). Changes will be reversible.`,
    }
  }

  return {
    safe: true,
    violations: [],
    userMessage: 'Intent is safe to execute.',
  }
}

/**
 * Check if removing/modifying auth-critical fields
 */
function checkAuthInvariant(
  intent: CanonicalIntent,
  graph: BackendStateGraph
): SafetyViolation | null {
  // Example: "Make user emails optional"
  if (
    intent.target === 'email' ||
    intent.source_text.toLowerCase().includes('email')
  ) {
    // Check if email is used for auth
    const usersEntity = graph.entities['users']
    if (usersEntity?.fields.email?.usedBy.includes('auth')) {
      return {
        type: 'AUTH_BREACH',
        severity: 'blocking',
        target: 'users.email',
        reason: 'Email is required for authentication',
        impact: [
          'Breaks login',
          'Existing users cannot sign in',
          'Auth invariant violated',
        ],
      }
    }
  }

  // Check if disabling auth providers while they're in use
  if (intent.domain === 'AUTH' && intent.action === 'DISABLE') {
    const provider = intent.feature?.toLowerCase()
    if (provider && graph.auth.providers[provider as keyof typeof graph.auth.providers]?.enabled) {
      return {
        type: 'AUTH_BREACH',
        severity: 'blocking',
        target: `auth.${provider}`,
        reason: `${provider} authentication is currently enabled and in use`,
        impact: ['Users relying on this method cannot sign in'],
      }
    }
  }

  return null
}

/**
 * Check if removing something will cause data loss
 */
function checkDataLoss(
  intent: CanonicalIntent,
  graph: BackendStateGraph
): SafetyViolation | null {
  if (intent.target) {
    // Check if target has dependencies
    const deps = findDependencies(graph, intent.target)
    
    if (deps.length > 0) {
      return {
        type: 'DATA_LOSS',
        severity: 'blocking',
        target: intent.target,
        reason: `Removing ${intent.target} will affect ${deps.length} dependent resource(s)`,
        impact: deps.map(dep => `Will break: ${dep}`),
      }
    }

    // Check if removing a field with data
    const [entityName, fieldName] = intent.target.split('.')
    if (entityName && fieldName) {
      const entity = graph.entities[entityName]
      if (entity?.fields[fieldName]) {
        return {
          type: 'DATA_LOSS',
          severity: 'warning',
          target: intent.target,
          reason: `Field ${fieldName} may contain user data`,
          impact: ['Existing data in this field will be lost'],
        }
      }
    }
  }

  return null
}

/**
 * Check if removing security features
 */
function checkSecurityDowngrade(
  intent: CanonicalIntent,
  graph: BackendStateGraph
): SafetyViolation | null {
  // Making API public when it was protected
  if (intent.feature === 'PUBLIC_ACCESS' && graph.auth.requirements.requireAuth) {
    return {
      type: 'SECURITY_DOWNGRADE',
      severity: 'blocking',
      target: 'api.auth',
      reason: 'Making APIs public removes authentication protection',
      impact: [
        'Anyone can access your data',
        'No user validation',
        'Security risk',
      ],
    }
  }

  return null
}

/**
 * Check for breaking changes to existing APIs
 */
function checkBreakingChanges(
  intent: CanonicalIntent,
  graph: BackendStateGraph
): SafetyViolation | null {
  // Removing or renaming entities breaks APIs
  if (
    (intent.intent_type === 'DATA_MODEL_REMOVE' || 
     intent.intent_type === 'DATA_MODEL_MODIFY') &&
    intent.target
  ) {
    const affectedApis = Object.values(graph.apis).filter(api =>
      api.dependsOn.includes(intent.target!)
    )

    if (affectedApis.length > 0) {
      return {
        type: 'BREAKING_CHANGE',
        severity: 'warning',
        target: intent.target,
        reason: `Modifying ${intent.target} will affect ${affectedApis.length} API(s)`,
        impact: affectedApis.map(api => `API ${api.path} will break`),
      }
    }
  }

  return null
}

/**
 * Generate safe alternative intent
 */
function generateSafeAlternative(
  originalIntent: CanonicalIntent,
  violations: SafetyViolation[],
  graph: BackendStateGraph
): CanonicalIntent | undefined {
  // If trying to make email optional, keep it required
  if (
    violations.some(v => v.type === 'AUTH_BREACH' && v.target.includes('email'))
  ) {
    return {
      ...originalIntent,
      intent_type: 'FEATURE_MODIFY',
      action: 'UPDATE',
      constraints: {
        ...originalIntent.constraints,
        keepRequired: true,
        reason: 'email_required_for_auth',
      },
    }
  }

  // If trying to remove auth, suggest making it optional instead
  if (violations.some(v => v.type === 'SECURITY_DOWNGRADE')) {
    return {
      ...originalIntent,
      action: 'UPDATE',
      constraints: {
        ...originalIntent.constraints,
        optionalAuth: true,
        publicRoutes: ['/public/*'],
      },
    }
  }

  return undefined
}

/**
 * Generate human-readable message for user
 */
function generateUserMessage(
  violations: SafetyViolation[],
  safeAlternative?: CanonicalIntent
): string {
  const mainViolation = violations[0]
  
  if (!mainViolation) return 'Something didn\'t work. Nothing was changed.'

  // Auth violation
  if (mainViolation.type === 'AUTH_BREACH') {
    if (mainViolation.target.includes('email')) {
      return 'Email is required for login. I kept it required and applied your change safely.'
    }
    return `This would break authentication. ${mainViolation.reason}. Nothing was changed.`
  }

  // Data loss
  if (mainViolation.type === 'DATA_LOSS') {
    return `This would affect ${mainViolation.impact.length} other part(s) of your backend. To protect your data, I didn't make this change.`
  }

  // Security downgrade
  if (mainViolation.type === 'SECURITY_DOWNGRADE') {
    return 'Making your API fully public could expose your data. If you want to allow some public access, try: "Let anyone view posts"'
  }

  // Breaking change
  if (mainViolation.type === 'BREAKING_CHANGE') {
    return `This would break ${mainViolation.impact.length} existing API(s). Your app might stop working.`
  }

  return 'Something didn\'t work. Nothing was changed.'
}

/**
 * Check if two intents conflict
 */
export function detectIntentConflict(
  intent1: CanonicalIntent,
  intent2: CanonicalIntent
): boolean {
  // Can't add and remove the same thing
  if (
    intent1.target === intent2.target &&
    intent1.intent_type === 'FEATURE_ADD' &&
    intent2.intent_type === 'FEATURE_REMOVE'
  ) {
    return true
  }

  // Can't enable and disable same auth provider
  if (
    intent1.domain === 'AUTH' &&
    intent2.domain === 'AUTH' &&
    intent1.feature === intent2.feature &&
    intent1.action !== intent2.action
  ) {
    return true
  }

  return false
}

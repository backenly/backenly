/**
 * PHASE 8 — FAILURE & UNSUPPORTED CASE HANDLING
 * 
 * Fail without fear.
 * Errors are human-readable, calm, and reassuring.
 * 
 * USER SEES: "This app uses features Backenly doesn't support yet."
 * USER NEVER SEES: Error codes, blame language, technical explanations
 */

import type { BackendBlueprint } from './intent-reconstruction'

export interface UnsupportedReason {
  category: 'complexity' | 'framework' | 'custom-backend' | 'database' | 'infrastructure'
  // Internal only - NEVER shown to user
  technical: string
  // User-facing message - calm and reassuring
  message: string
}

export interface ConnectionFailureResult {
  canConnect: boolean
  unsupportedReasons: UnsupportedReason[]
  // User-facing message ONLY
  userMessage: string
  // Alternative actions (hidden in message)
  alternatives: Array<'export' | 'manual-setup' | 'contact-support'>
}

/**
 * Check if app can be connected to Backenly
 * Gracefully handle unsupported cases
 */
export function checkConnectionSupport(
  blueprint: BackendBlueprint,
  appUrl: string,
  provider: string
): ConnectionFailureResult {
  const unsupportedReasons: UnsupportedReason[] = []

  // Check 1: Complex custom backend logic
  if (hasComplexCustomLogic(blueprint)) {
    unsupportedReasons.push({
      category: 'complexity',
      technical: 'Custom server-side logic detected: WebSockets, cron jobs, custom middleware',
      message: 'Your app has custom features',
    })
  }

  // Check 2: Unsupported framework
  if (isUnsupportedFramework(provider, appUrl)) {
    unsupportedReasons.push({
      category: 'framework',
      technical: 'Framework not supported: Django, Rails, Laravel, etc.',
      message: 'Your app uses a framework we don\'t support yet',
    })
  }

  // Check 3: Complex database setup
  if (hasComplexDatabase(blueprint)) {
    unsupportedReasons.push({
      category: 'database',
      technical: 'Complex database detected: multi-database, sharding, custom indices',
      message: 'Your data setup is more complex than we can handle',
    })
  }

  // Check 4: Custom infrastructure
  if (hasCustomInfrastructure(provider, appUrl)) {
    unsupportedReasons.push({
      category: 'infrastructure',
      technical: 'Custom infrastructure: Docker, Kubernetes, custom deployment',
      message: 'Your app has custom hosting',
    })
  }

  // Determine if we can connect
  const canConnect = unsupportedReasons.length === 0

  // Generate user-facing message
  const userMessage = canConnect
    ? 'Ready to connect'
    : generateFailureMessage(unsupportedReasons)

  return {
    canConnect,
    unsupportedReasons,
    userMessage,
    alternatives: canConnect ? [] : ['export', 'contact-support'],
  }
}

/**
 * Generate calm, human-readable failure message
 * NO error codes, NO blame, NO technical explanations
 */
function generateFailureMessage(reasons: UnsupportedReason[]): string {
  // Default calm message
  if (reasons.length === 0) {
    return "Something didn't work. You can continue without Backenly."
  }

  // Single reason
  if (reasons.length === 1) {
    return `This app uses features Backenly doesn't support yet. You can continue without Backenly, or try exporting.`
  }

  // Multiple reasons (still calm)
  return `This app uses features Backenly doesn't support yet. You can continue without Backenly, or try exporting.`
}

/**
 * Detect complex custom backend logic
 */
function hasComplexCustomLogic(blueprint: BackendBlueprint): boolean {
  // Check for complex patterns in blueprint
  // This would be detected during app discovery (Phase 3)
  
  // For now, check entity count as proxy
  // Real apps with 20+ entities likely have complex logic
  if (blueprint.entities.length > 20) {
    return true
  }

  // Check for complex relationships
  const totalRelationships = blueprint.entities.reduce(
    (sum, entity) => sum + entity.relationships.length,
    0
  )
  if (totalRelationships > 50) {
    return true
  }

  return false
}

/**
 * Check if framework is unsupported
 */
function isUnsupportedFramework(provider: string, appUrl: string): boolean {
  // TODO: Implement actual framework detection
  // This would inspect the app during discovery
  
  // Supported frameworks: Next.js, React, Vue, Vite, Remix
  // Unsupported: Django, Rails, Laravel, Spring Boot, .NET, etc.
  
  // For now, assume supported (will be enhanced in production)
  return false
}

/**
 * Check if database is too complex
 */
function hasComplexDatabase(blueprint: BackendBlueprint): boolean {
  // Check for complex database patterns
  
  // Too many entities
  if (blueprint.entities.length > 30) {
    return true
  }

  // Check for many-to-many relationships
  const hasManyToMany = blueprint.entities.some((entity) =>
    entity.relationships.some((rel) => rel.includes('many-to-many'))
  )
  if (hasManyToMany) {
    // Many-to-many is complex, but we can handle a few
    const manyToManyCount = blueprint.entities.filter((entity) =>
      entity.relationships.some((rel) => rel.includes('many-to-many'))
    ).length
    if (manyToManyCount > 3) {
      return true
    }
  }

  return false
}

/**
 * Check for custom infrastructure
 */
function hasCustomInfrastructure(provider: string, appUrl: string): boolean {
  // TODO: Implement actual infrastructure detection
  // This would inspect deployment config during discovery
  
  // Custom: Docker, Kubernetes, AWS ECS, custom deployment
  // Supported: Standard hosting (Vercel, Netlify, Replit, etc.)
  
  return false
}

/**
 * Sanitize any connection error to human-readable message
 * (Extension of Phase 14 error sanitization)
 */
export function sanitizeConnectionError(error: unknown): string {
  // Log internally (never shown to user)
  console.error('[Connection Error]', error)

  // All errors become this calm message
  return "Something didn't work. You can continue without Backenly, or try exporting."
}

/**
 * Safety Rails - Production Hardening
 * 
 * These are PLATFORM-ENFORCED security rules
 * NOT user-optional configuration
 * 
 * Prevents data loss, abuse, and security vulnerabilities
 */

export interface SafetyRules {
  // Dangerous operations require authentication
  deleteRequiresAuth: boolean
  updateRequiresAuth: boolean
  bulkRequiresAuth: boolean
  
  // Soft delete is default (prevents accidental data loss)
  softDeleteDefault: boolean
  
  // Bulk operations disabled by default (abuse risk)
  bulkDisabledByDefault: boolean
  
  // Search field whitelisting (injection safety)
  searchFieldsWhitelisted: boolean
  
  // Max records per request (DOS prevention)
  maxRecordsPerRequest: number
  
  // Max bulk operations per request
  maxBulkOperations: number
  
  // Require explicit confirmation for dangerous operations
  requireConfirmationForDelete: boolean
}

/**
 * Default Safety Rules (Production-Ready)
 */
export const DEFAULT_SAFETY_RULES: SafetyRules = {
  deleteRequiresAuth: true,
  updateRequiresAuth: true,
  bulkRequiresAuth: true,
  softDeleteDefault: true,
  bulkDisabledByDefault: true,
  searchFieldsWhitelisted: true,
  maxRecordsPerRequest: 1000,
  maxBulkOperations: 100,
  requireConfirmationForDelete: false, // Can be enabled for extra safety
}

/**
 * Validate Operation Against Safety Rules
 */
export function validateOperationSafety(
  operation: string,
  authRequired: boolean,
  isAuthenticated: boolean,
  config?: Partial<SafetyRules>
): { allowed: boolean; reason?: string } {
  const rules = { ...DEFAULT_SAFETY_RULES, ...config }

  // DELETE must have auth
  if (operation === 'delete' && rules.deleteRequiresAuth && !isAuthenticated) {
    return {
      allowed: false,
      reason: 'DELETE operations require authentication (safety rail)',
    }
  }

  // UPDATE must have auth
  if (operation === 'update' && rules.updateRequiresAuth && !isAuthenticated) {
    return {
      allowed: false,
      reason: 'UPDATE operations require authentication (safety rail)',
    }
  }

  // BULK operations must have auth
  if (operation === 'bulk' && rules.bulkRequiresAuth && !isAuthenticated) {
    return {
      allowed: false,
      reason: 'BULK operations require authentication (safety rail)',
    }
  }

  // BULK operations disabled by default
  if (operation === 'bulk' && rules.bulkDisabledByDefault && !authRequired) {
    return {
      allowed: false,
      reason: 'BULK operations must be explicitly enabled (abuse risk)',
    }
  }

  return { allowed: true }
}

/**
 * Validate Request Size Against Safety Rules
 */
export function validateRequestSize(
  operation: string,
  recordCount: number,
  config?: Partial<SafetyRules>
): { allowed: boolean; reason?: string } {
  const rules = { ...DEFAULT_SAFETY_RULES, ...config }

  if (operation === 'list' && recordCount > rules.maxRecordsPerRequest) {
    return {
      allowed: false,
      reason: `Maximum ${rules.maxRecordsPerRequest} records per request (DOS prevention)`,
    }
  }

  if (operation === 'bulk' && recordCount > rules.maxBulkOperations) {
    return {
      allowed: false,
      reason: `Maximum ${rules.maxBulkOperations} bulk operations per request (abuse prevention)`,
    }
  }

  return { allowed: true }
}

/**
 * Get Safe Delete Strategy
 * 
 * Returns whether to use soft delete or hard delete
 */
export function getSafeDeleteStrategy(
  apiDefinitionConfig?: any,
  safetyConfig?: Partial<SafetyRules>
): 'soft' | 'hard' {
  const rules = { ...DEFAULT_SAFETY_RULES, ...safetyConfig }
  
  // Check API definition config first
  if (apiDefinitionConfig?.softDelete !== undefined) {
    return apiDefinitionConfig.softDelete ? 'soft' : 'hard'
  }
  
  // Default to soft delete (safety rail)
  return rules.softDeleteDefault ? 'soft' : 'hard'
}

/**
 * Whitelist Search Fields
 * 
 * Prevents SQL injection through search
 */
export function whitelistSearchFields(
  requestedFields: string[],
  allowedFields: string[]
): { allowed: string[]; rejected: string[] } {
  const allowed: string[] = []
  const rejected: string[] = []

  requestedFields.forEach(field => {
    // Only allow alphanumeric + underscore
    if (!/^[a-zA-Z0-9_]+$/.test(field)) {
      rejected.push(field)
      return
    }

    // Check against whitelist
    if (allowedFields.includes(field)) {
      allowed.push(field)
    } else {
      rejected.push(field)
    }
  })

  return { allowed, rejected }
}

/**
 * Validate Field Name (Injection Prevention)
 */
export function isValidFieldName(fieldName: string): boolean {
  // Only allow: letters, numbers, underscore
  // No spaces, special characters, SQL keywords
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(fieldName)
}

/**
 * Detect Dangerous SQL Patterns
 */
export function containsDangerousPattern(input: string): boolean {
  const dangerousPatterns = [
    /drop\s+table/i,
    /truncate\s+table/i,
    /delete\s+from/i,
    /update\s+.*\s+set/i,
    /insert\s+into/i,
    /exec\s*\(/i,
    /execute\s*\(/i,
    /;\s*--/,
    /union\s+select/i,
    /\/\*.*\*\//,
    /<script/i,
  ]

  return dangerousPatterns.some(pattern => pattern.test(input))
}

/**
 * Sanitize User Input
 */
export function sanitizeInput(input: any): any {
  if (typeof input === 'string') {
    // Remove dangerous patterns
    if (containsDangerousPattern(input)) {
      throw new Error('Input contains dangerous patterns')
    }
    return input
  }

  if (Array.isArray(input)) {
    return input.map(sanitizeInput)
  }

  if (typeof input === 'object' && input !== null) {
    const sanitized: any = {}
    for (const [key, value] of Object.entries(input)) {
      if (!isValidFieldName(key)) {
        throw new Error(`Invalid field name: ${key}`)
      }
      sanitized[key] = sanitizeInput(value)
    }
    return sanitized
  }

  return input
}

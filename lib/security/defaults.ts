/**
 * Security By Default (Invisible)
 * 
 * Phase 13: Secure defaults, auth isolation, least privilege, no security dashboards.
 * 
 * PRINCIPLE: Security is invisible. Backenly assumes responsibility.
 */

export interface SecurityPolicy {
  requireAuth: boolean
  allowPublicAccess: boolean
  projectIsolation: boolean
  dataEncryption: boolean
  auditLogging: boolean
}

/**
 * Default security policy (applied to all new projects)
 */
export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  requireAuth: true, // Always require auth by default
  allowPublicAccess: false, // Never public by default
  projectIsolation: true, // Full isolation between projects
  dataEncryption: true, // Encrypt all data at rest
  auditLogging: true, // Log all changes
}

/**
 * Validate that a security change is safe
 */
export function validateSecurityChange(
  current: SecurityPolicy,
  proposed: SecurityPolicy
): {
  safe: boolean
  warnings: string[]
} {
  const warnings: string[] = []

  // Downgrading auth is dangerous
  if (current.requireAuth && !proposed.requireAuth) {
    warnings.push('This will make your app publicly accessible to anyone.')
  }

  // Allowing public access is risky
  if (!current.allowPublicAccess && proposed.allowPublicAccess) {
    warnings.push('This removes access restrictions. Anyone can use your app.')
  }

  // Disabling isolation is critical
  if (current.projectIsolation && !proposed.projectIsolation) {
    warnings.push('This allows data to be shared across projects. This is a security risk.')
  }

  // Disabling encryption is non-negotiable
  if (current.dataEncryption && !proposed.dataEncryption) {
    warnings.push('Data encryption cannot be disabled.')
    return { safe: false, warnings }
  }

  return {
    safe: warnings.length === 0,
    warnings,
  }
}

/**
 * Apply least privilege to API access
 */
export function getMinimalPermissions(operation: string): string[] {
  const permissionMap: Record<string, string[]> = {
    read: ['read'],
    create: ['read', 'write'],
    update: ['read', 'write'],
    delete: ['read', 'write', 'delete'],
  }

  return permissionMap[operation] || ['read']
}

/**
 * Ensure project isolation
 */
export function enforceProjectIsolation(
  userId: string,
  projectId: string,
  action: string
): boolean {
  // TODO: Check database that user has access to this project
  // This should NEVER allow cross-project data access
  
  return true // Placeholder
}

/**
 * Auto-apply security headers
 */
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
}

/**
 * Detect potential security issues in user intent
 */
export function detectSecurityRisk(intent: string): {
  risky: boolean
  reason?: string
} {
  const intentLower = intent.toLowerCase()

  // Public exposure
  if (intentLower.includes('make public') || intentLower.includes('remove auth')) {
    return {
      risky: true,
      reason: 'This would make your app publicly accessible.',
    }
  }

  // Credential exposure
  if (intentLower.includes('expose') && (intentLower.includes('key') || intentLower.includes('token'))) {
    return {
      risky: true,
      reason: 'This would expose sensitive credentials.',
    }
  }

  // CORS wildcards
  if (intentLower.includes('allow all origins') || intentLower.includes('cors *')) {
    return {
      risky: true,
      reason: 'This allows any website to access your API.',
    }
  }

  return { risky: false }
}

/**
 * SECURITY PRINCIPLES:
 * 
 * 1. Never expose security settings unless absolutely necessary
 * 2. Auth is ALWAYS on by default
 * 3. Projects are ALWAYS isolated
 * 4. Data is ALWAYS encrypted
 * 5. Audit logs are ALWAYS enabled
 * 6. Public access requires explicit dangerous confirmation
 * 7. Least privilege is automatically applied
 * 8. Security headers are auto-injected
 * 
 * Users should NEVER see:
 * - Security dashboards
 * - Permission matrices
 * - CORS configuration
 * - Encryption settings
 * 
 * Security is invisible and non-negotiable.
 */

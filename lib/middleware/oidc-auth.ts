/**
 * OIDC Authentication Middleware
 * 
 * Validates standard Bearer tokens from OIDC flow
 * Replaces custom delegation token middleware
 * 
 * Standards-compliant, auditable, no magic
 */

import { NextRequest } from 'next/server'
import { validateOIDCToken, OIDCTokenClaims, parseScopeString } from '@/lib/auth/oidc-delegation'

export interface OIDCAuthContext {
  projectId: string
  clientId: string
  connectionId: string
  permissions: {
    readSchema: boolean
    readEndpoints: boolean
    callApis: boolean
    authenticateSessions: boolean
  }
  scope: string
  expiresAt: number
}

/**
 * Validate OIDC Bearer token from request
 * 
 * Standard HTTP Authorization header:
 * Authorization: Bearer {access_token}
 * 
 * RFC 6750 - OAuth 2.0 Bearer Token Usage
 */
export async function validateOIDCRequest(
  request: NextRequest
): Promise<OIDCAuthContext | null> {
  // Extract Bearer token from Authorization header
  const authHeader = request.headers.get('authorization')
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null
  }
  
  const token = authHeader.substring(7)
  
  try {
    // Validate OIDC token (checks signature, expiration, revocation)
    const claims = await validateOIDCToken(token)
    
    if (!claims) {
      return null
    }
    
    // Parse scope string into permissions
    const permissions = parseScopeString(claims.scope)
    
    // Return auth context
    return {
      projectId: claims.aud,  // Audience = project ID
      clientId: claims.client_id,
      connectionId: claims.sub,  // Subject = connection ID
      permissions,
      scope: claims.scope,
      expiresAt: claims.exp,
    }
  } catch (error) {
    console.error('[OIDC Auth] Token validation failed:', error)
    return null
  }
}

/**
 * Require specific permission
 * 
 * Used by API routes to check if request has required permission
 */
export function requireOIDCPermission(
  context: OIDCAuthContext | null,
  permission: keyof OIDCAuthContext['permissions']
): boolean {
  if (!context) return false
  return context.permissions[permission] === true
}

/**
 * Get project ID from OIDC context
 * 
 * SECURITY: Project ID comes from validated token (not query params)
 */
export function getOIDCProjectId(
  context: OIDCAuthContext | null
): string | null {
  return context?.projectId || null
}

/**
 * Check if OIDC token is expired
 */
export function isOIDCTokenExpired(
  context: OIDCAuthContext
): boolean {
  const now = Math.floor(Date.now() / 1000)
  return context.expiresAt <= now
}

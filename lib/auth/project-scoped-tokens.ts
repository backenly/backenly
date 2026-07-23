/**
 * PHASE 2: Project-Scoped Auth Token System
 * 
 * Auth tokens embed {project_id, user_id} and are validated against project boundary
 * Tokens cannot be used outside their originating project
 */

import jwt from 'jsonwebtoken'
import { ExecutionContext } from '@/lib/context/execution-context'

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key'
const TOKEN_EXPIRY = '7d'

/**
 * Project-scoped JWT payload
 * 
 * CRITICAL: Includes project_id as immutable claim
 */
export interface ProjectScopedTokenPayload {
  /** User ID within the project namespace */
  userId: string
  
  /** Project ID - immutable boundary */
  projectId: string
  
  /** User email (optional) */
  email?: string
  
  /** Token issued at */
  iat: number
  
  /** Token expires at */
  exp: number
}

/**
 * Auth token error
 */
export class AuthTokenError extends Error {
  constructor(message: string, public code: string) {
    super(message)
    this.name = 'AuthTokenError'
  }
}

/**
 * Generate project-scoped auth token
 * 
 * Token embeds project_id and user_id
 */
export function generateProjectScopedToken(
  userId: string,
  projectId: string,
  email?: string
): string {
  const payload: Omit<ProjectScopedTokenPayload, 'iat' | 'exp'> = {
    userId,
    projectId,
    email,
  }
  
  const token = jwt.sign(payload, JWT_SECRET, {
    expiresIn: TOKEN_EXPIRY,
  })
  
  console.log(`[Auth] Generated token for user ${userId} in project ${projectId}`)
  
  return token
}

/**
 * Verify and decode project-scoped token
 * 
 * Returns payload if valid, throws AuthTokenError if invalid
 */
export function verifyProjectScopedToken(token: string): ProjectScopedTokenPayload {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as ProjectScopedTokenPayload
    
    // Validate required fields
    if (!payload.userId || !payload.projectId) {
      throw new AuthTokenError(
        'Invalid token: missing userId or projectId',
        'INVALID_TOKEN'
      )
    }
    
    return payload
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new AuthTokenError('Token expired', 'TOKEN_EXPIRED')
    }
    
    if (error instanceof jwt.JsonWebTokenError) {
      throw new AuthTokenError('Invalid token', 'INVALID_TOKEN')
    }
    
    throw error
  }
}

/**
 * Validate token against execution context
 * 
 * CRITICAL: Ensures token's project_id matches current execution context
 * Prevents token from being used in wrong project
 */
export function validateTokenForContext(
  token: string,
  context: ExecutionContext
): ProjectScopedTokenPayload {
  const payload = verifyProjectScopedToken(token)
  
  // SECURITY: Token's projectId MUST match execution context
  if (payload.projectId !== context.projectId) {
    throw new AuthTokenError(
      `Token project mismatch: token is for project ${payload.projectId}, ` +
      `but request is for project ${context.projectId}`,
      'PROJECT_MISMATCH'
    )
  }
  
  // SECURITY: If context has userId, it must match token
  if (context.userId && payload.userId !== context.userId) {
    throw new AuthTokenError(
      'Token user mismatch',
      'USER_MISMATCH'
    )
  }
  
  console.log(
    `[Auth] Validated token for user ${payload.userId} in project ${payload.projectId}`
  )
  
  return payload
}

/**
 * Extract token from Authorization header
 */
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null
  
  const parts = authHeader.split(' ')
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return null
  }
  
  return parts[1]
}

/**
 * Refresh token (generates new token with same claims)
 */
export function refreshToken(oldToken: string): string {
  const payload = verifyProjectScopedToken(oldToken)
  
  return generateProjectScopedToken(
    payload.userId,
    payload.projectId,
    payload.email
  )
}

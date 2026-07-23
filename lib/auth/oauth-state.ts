/**
 * OAuth State Management - signed-state pattern
 * 
 * CRITICAL SECURITY REQUIREMENT:
 * State parameter MUST include signed(projectId + nonce) to prevent:
 * - CSRF attacks
 * - Session hijacking  
 * - Cross-project token leakage
 */

import { sign, verify } from 'jsonwebtoken'
import crypto from 'crypto'

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is not set')
const JWT_SECRET = process.env.JWT_SECRET
const STATE_EXPIRY = '5m' // State expires in 5 minutes

export interface OAuthState {
  projectId: string
  nonce: string
  redirectTo?: string
  provider: 'google' | 'github' | 'microsoft'
  timestamp: number
}

/**
 * Generate cryptographically signed OAuth state parameter
 * Pattern A (BEST - signed state carrying projectId + nonce)
 */
export function generateOAuthState(params: {
  projectId: string
  provider: 'google' | 'github' | 'microsoft'
  redirectTo?: string
}): string {
  const nonce = crypto.randomBytes(16).toString('hex')
  
  const statePayload: OAuthState = {
    projectId: params.projectId,
    nonce,
    redirectTo: params.redirectTo || '/app',
    provider: params.provider,
    timestamp: Date.now(),
  }

  // Sign the entire payload with JWT — algorithm pinned to HS256.
  const signedState = sign(statePayload, JWT_SECRET, {
    expiresIn: STATE_EXPIRY,
    algorithm: 'HS256',
  })

  // Base64 encode for URL safety
  return Buffer.from(signedState).toString('base64url')
}

/**
 * Verify and decode OAuth state parameter
 * MUST be called BEFORE any user creation or session issuance
 */
export function verifyOAuthState(
  stateParam: string | null
): OAuthState | null {
  if (!stateParam) {
    return null
  }

  try {
    // Decode from base64
    const signedState = Buffer.from(stateParam, 'base64url').toString()

    // Verify JWT signature and expiry — algorithm pinned to HS256.
    const decoded = verify(signedState, JWT_SECRET, { algorithms: ['HS256'] }) as OAuthState

    // Validate timestamp (max 5 minutes old)
    const age = Date.now() - decoded.timestamp
    if (age > 5 * 60 * 1000) {
      throw new Error('State expired')
    }

    // Ensure required fields exist
    if (!decoded.projectId || !decoded.nonce || !decoded.provider) {
      throw new Error('Invalid state payload')
    }

    return decoded
  } catch (error: any) {
    console.error('[OAuth State] Verification failed:', error.message)
    return null
  }
}

/**
 * Validate that state matches expected provider
 */
export function validateStateProvider(
  state: OAuthState,
  expectedProvider: 'google' | 'github' | 'microsoft'
): boolean {
  return state.provider === expectedProvider
}

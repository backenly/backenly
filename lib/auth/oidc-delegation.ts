/**
 * OIDC-Compliant Delegation Tokens
 * 
 * PHILOSOPHY-SAFE AUTH WITHOUT SDK
 * 
 * ═══════════════════════════════════════════════════════════════════════
 * STANDARDS-BASED SECURITY (AUDITABLE, NO MAGIC)
 * ═══════════════════════════════════════════════════════════════════════
 * 
 * REQUIREMENTS:
 * - Auth tokens issued via standard OIDC flows (not custom schemes)
 * - Frontends authenticate via redirect or iframe handshake (not token copying)
 * - Tokens are scoped, short-lived, revocable (not eternal access)
 * - No SDK required (pure HTTP + standards)
 * 
 * CONSTRAINTS:
 * - Users never handle secrets (server-to-server only)
 * - No token copying (automatic injection via handshake)
 * - No auth config UI (zero-config for end users)
 * 
 * SUCCESS:
 * - Auth is standards-compliant and auditable
 * - No custom token schemes
 * - No fetch interception hacks
 * 
 * ═══════════════════════════════════════════════════════════════════════
 * OIDC FLOW (RFC 6749 + OpenID Connect Core 1.0)
 * ═══════════════════════════════════════════════════════════════════════
 * 
 * 1. Frontend redirects to Backenly authorization endpoint
 * 2. Backenly validates project ownership, generates auth code
 * 3. Redirect back to frontend with code (short-lived, single-use)
 * 4. Frontend exchanges code for access_token via token endpoint
 * 5. Frontend uses access_token as Bearer token (standard HTTP)
 * 6. Token expires after 1 hour, must refresh or re-authenticate
 * 
 * NO SDK NEEDED:
 * - Standard OAuth2/OIDC client libraries work out of box
 * - Pure HTTP requests (fetch, axios, etc.)
 * - No custom SDKs, no magic
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { sign, verify } from 'jsonwebtoken'
import crypto from 'crypto'

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is not set')
const JWT_SECRET = process.env.JWT_SECRET
const ISSUER = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

/**
 * OIDC Token Claims (RFC 7519 + OpenID Connect Core 1.0)
 */
export interface OIDCTokenClaims {
  iss: string          // Issuer (Backenly URL)
  sub: string          // Subject (connection ID)
  aud: string          // Audience (project ID)
  exp: number          // Expiration time (Unix timestamp)
  iat: number          // Issued at (Unix timestamp)
  jti: string          // JWT ID (unique token identifier)
  scope: string        // Space-separated scopes (OIDC standard)
  client_id: string    // Client identifier (frontend provider)
}

/**
 * Authorization Code (short-lived, single-use)
 * 
 * OIDC Authorization Code Flow (RFC 6749 Section 4.1)
 */
export interface AuthorizationCode {
  code: string         // Authorization code
  projectId: string    // Project being authorized
  clientId: string     // Frontend client (replit, lovable, etc.)
  scope: string        // Requested scopes
  expiresAt: Date      // Expires in 10 minutes (RFC 6749 recommends 10min)
  codeChallenge?: string  // PKCE code challenge (optional, recommended)
  used: boolean        // Single-use enforcement
}

/**
 * OIDC-Compliant Access Token
 */
export interface OIDCAccessToken {
  access_token: string      // JWT access token
  token_type: 'Bearer'      // Always Bearer (OIDC standard)
  expires_in: number        // Seconds until expiration
  scope: string             // Granted scopes
  id_token?: string         // Optional ID token (OIDC)
}

/**
 * Step 1: Authorization Request
 * 
 * GET /api/oidc/authorize?
 *   response_type=code
 *   &client_id=replit
 *   &project_id={projectId}
 *   &scope=read:schema+read:endpoints+call:apis
 *   &redirect_uri={frontendUrl}
 *   &state={csrf_token}
 * 
 * OIDC Authorization Endpoint (RFC 6749 Section 3.1)
 */
export async function handleAuthorizationRequest(
  request: NextRequest,
  userId: string  // From session/auth middleware
): Promise<{
  redirectUrl: string
  authorizationCode: string
}> {
  const { searchParams } = new URL(request.url)
  
  const responseType = searchParams.get('response_type')
  const clientId = searchParams.get('client_id')
  const projectId = searchParams.get('project_id')
  const scope = searchParams.get('scope') || 'read:schema read:endpoints'
  const redirectUri = searchParams.get('redirect_uri')
  const state = searchParams.get('state')
  const codeChallenge = searchParams.get('code_challenge')  // PKCE
  
  // Validate required parameters (RFC 6749 Section 4.1.1)
  if (responseType !== 'code') {
    throw new OIDCError('unsupported_response_type', 'Only code flow is supported')
  }
  
  if (!clientId || !projectId || !redirectUri) {
    throw new OIDCError('invalid_request', 'Missing required parameters')
  }
  
  // Verify project ownership (Backenly-specific authorization)
  const project = await prisma.project.findFirst({
    where: {
      id: projectId,
      userId: userId,
    },
  })
  
  if (!project) {
    throw new OIDCError('access_denied', 'Project not found or access denied')
  }
  
  // Validate redirect URI (prevent open redirect attacks)
  if (!isValidRedirectUri(redirectUri, clientId)) {
    throw new OIDCError('invalid_request', 'Invalid redirect_uri')
  }
  
  // Generate authorization code (short-lived, single-use)
  const code = generateAuthorizationCode()
  const codeHash = crypto.createHash('sha256').update(code).digest('hex')
  
  // TODO: OIDC auth temporarily disabled - Prisma model missing
  throw new Error('OIDC delegation temporarily disabled')
  
  /*
  // Store authorization code (expires in 10 minutes)
  await prisma.oAuthAuthorizationCode.create({
    data: {
      code: codeHash,
      projectId,
      clientId,
      scope,
      redirectUri,
      codeChallenge: codeChallenge || null,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
      used: false,
    },
  })
  
  // Build redirect URL with authorization code (RFC 6749 Section 4.1.2)
  const redirectUrl = new URL(redirectUri)
  redirectUrl.searchParams.set('code', code)
  if (state) {
    redirectUrl.searchParams.set('state', state)  // CSRF protection
  }
  
  console.log(`[OIDC] Authorization code issued: client=${clientId}, project=${projectId.slice(0, 8)}`)
  
  return {
    redirectUrl: redirectUrl.toString(),
    authorizationCode: code,
  }
  */
}

/**
 * Step 2: Token Exchange
 * 
 * POST /api/oidc/token
 * Content-Type: application/x-www-form-urlencoded
 * 
 * grant_type=authorization_code
 * &code={authorization_code}
 * &redirect_uri={redirect_uri}
 * &client_id={client_id}
 * &code_verifier={code_verifier}  // PKCE
 * 
 * OIDC Token Endpoint (RFC 6749 Section 3.2)
 */
export async function handleTokenExchange(
  request: NextRequest
): Promise<OIDCAccessToken> {
  const body = await request.text()
  const params = new URLSearchParams(body)
  
  const grantType = params.get('grant_type')
  const code = params.get('code')
  const redirectUri = params.get('redirect_uri')
  const clientId = params.get('client_id')
  const codeVerifier = params.get('code_verifier')  // PKCE
  
  // Validate grant type (RFC 6749 Section 4.1.3)
  if (grantType !== 'authorization_code') {
    throw new OIDCError('unsupported_grant_type', 'Only authorization_code is supported')
  }
  
  if (!code || !redirectUri || !clientId) {
    throw new OIDCError('invalid_request', 'Missing required parameters')
  }
  
  // TODO: OIDC auth temporarily disabled
  throw new Error('OIDC token exchange temporarily disabled')
  
  /*
  // Look up authorization code
  const codeHash = crypto.createHash('sha256').update(code).digest('hex')
  
  const authCode = await prisma.oAuthAuthorizationCode.findFirst({
    where: {
      code: codeHash,
      clientId,
      redirectUri,
      used: false,
      expiresAt: { gt: new Date() },
    },
  })
  
  if (!authCode) {
    throw new OIDCError('invalid_grant', 'Authorization code is invalid, expired, or already used')
  }
  
  // Verify PKCE if code_challenge was provided (RFC 7636)
  if (authCode.codeChallenge) {
    if (!codeVerifier) {
      throw new OIDCError('invalid_request', 'code_verifier required for PKCE')
    }
    
    const computedChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url')
    
    if (computedChallenge !== authCode.codeChallenge) {
      throw new OIDCError('invalid_grant', 'Invalid code_verifier')
    }
  }
  
  // Mark code as used (single-use enforcement)
  await prisma.oAuthAuthorizationCode.update({
    where: { id: authCode.id },
    data: { used: true },
  })
  
  // Generate OIDC-compliant access token (JWT)
  const now = Math.floor(Date.now() / 1000)
  const expiresIn = 3600  // 1 hour (standard OIDC lifetime)
  
  const tokenClaims: OIDCTokenClaims = {
    iss: ISSUER,
    sub: authCode.id,  // Connection identifier
    aud: authCode.projectId,  // Project scope
    exp: now + expiresIn,
    iat: now,
    jti: crypto.randomUUID(),
    scope: authCode.scope,
    client_id: authCode.clientId,
  }
  
  const accessToken = sign(tokenClaims, JWT_SECRET, {
    algorithm: 'HS256',
  })
  
  // Store token for revocation tracking
  await prisma.oIDCAccessToken.create({
    data: {
      jti: tokenClaims.jti,
      projectId: authCode.projectId,
      clientId: authCode.clientId,
      scope: authCode.scope,
      expiresAt: new Date(tokenClaims.exp * 1000),
      revoked: false,
    },
  })
  
  console.log(`[OIDC] Access token issued: client=${clientId}, project=${authCode.projectId.slice(0, 8)}, exp=${expiresIn}s`)
  
  // Return OIDC-compliant token response (RFC 6749 Section 5.1)
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: expiresIn,
    scope: authCode.scope,
  }
  */
}

/**
 * Step 3: Token Validation
 * 
 * Used by API middleware to validate incoming Bearer tokens
 * 
 * Authorization: Bearer {access_token}
 */
export async function validateOIDCToken(
  token: string
): Promise<OIDCTokenClaims | null> {
  try {
    // Verify JWT signature and expiration
    const claims = verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: ISSUER,
    }) as OIDCTokenClaims
    
    // TODO: OIDC temporarily disabled
    return null
    
    /*
    // Check if token has been revoked
    const tokenRecord = await prisma.oIDCAccessToken.findUnique({
      where: { jti: claims.jti },
    })
    
    if (!tokenRecord || tokenRecord.revoked) {
      console.warn(`[OIDC] Token validation failed: revoked (jti=${claims.jti})`)
      return null
    }
    
    return claims
    */
  } catch (error) {
    console.warn(`[OIDC] Token validation failed:`, error)
    return null
  }
}

/**
 * Token Revocation
 * 
 * POST /api/oidc/revoke
 * 
 * token={access_token}
 * &client_id={client_id}
 * 
 * RFC 7009 - OAuth 2.0 Token Revocation
 */
export async function revokeOIDCToken(
  token: string,
  clientId: string
): Promise<void> {
  try {
    // TODO: OIDC temporarily disabled
    console.log(`[OIDC] Token revocation requested but temporarily disabled`)
    return
    
    /*
    const claims = verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: ISSUER,
    }) as OIDCTokenClaims
    
    // Verify client ownership
    if (claims.client_id !== clientId) {
      throw new OIDCError('unauthorized_client', 'Token does not belong to this client')
    }
    
    // Revoke token
    await prisma.oIDCAccessToken.update({
      where: { jti: claims.jti },
      data: { 
        revoked: true,
        revokedAt: new Date(),
      },
    })
    
    console.log(`[OIDC] Token revoked: jti=${claims.jti}`)
    */
  } catch (error) {
    console.warn(`[OIDC] Token revocation failed:`, error)
    // RFC 7009: Revocation endpoint should return 200 even if token invalid
  }
}

/**
 * OIDC Error (RFC 6749 Section 5.2)
 */
export class OIDCError extends Error {
  constructor(
    public error: string,
    public error_description: string
  ) {
    super(error_description)
    this.name = 'OIDCError'
  }
  
  toJSON() {
    return {
      error: this.error,
      error_description: this.error_description,
    }
  }
}

/**
 * Generate cryptographically secure authorization code
 */
function generateAuthorizationCode(): string {
  return `authz_${crypto.randomBytes(32).toString('base64url')}`
}

/**
 * Validate redirect URI (prevent open redirect attacks)
 * 
 * SECURITY: Only allow known frontend providers
 */
function isValidRedirectUri(redirectUri: string, clientId: string): boolean {
  try {
    const url = new URL(redirectUri)
    
    // Allowlist for known providers
    const allowedOrigins: Record<string, string[]> = {
      'replit': ['replit.com', 'repl.co'],
      'lovable': ['lovable.dev', 'lovable.app'],
      'bolt': ['bolt.new'],
      'vercel': ['vercel.app'],
      'cursor': ['cursor.sh'],
      'localhost': ['localhost', '127.0.0.1'],
    }
    
    const allowed = allowedOrigins[clientId] || []
    
    return allowed.some(domain => 
      url.hostname === domain || url.hostname.endsWith(`.${domain}`)
    )
  } catch {
    return false
  }
}

/**
 * Extract scope permissions from OIDC scope string
 * 
 * Example: "read:schema read:endpoints call:apis" → permissions object
 */
export function parseScopeString(scope: string): {
  readSchema: boolean
  readEndpoints: boolean
  callApis: boolean
  authenticateSessions: boolean
} {
  const scopes = scope.split(' ')
  
  return {
    readSchema: scopes.includes('read:schema'),
    readEndpoints: scopes.includes('read:endpoints'),
    callApis: scopes.includes('call:apis'),
    authenticateSessions: scopes.includes('authenticate:sessions'),
  }
}

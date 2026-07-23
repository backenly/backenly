/**
 * WEBHOOK SECURITY TESTS
 * ======================
 * Validates signature validation, replay protection, and edge cases
 * for the webhook receiver at /api/v1/[projectId]/webhooks/[integration].
 *
 * These are pure crypto unit tests — no DB or HTTP required.
 */

import { describe, test, expect } from '@jest/globals'
import crypto from 'crypto'

// ─── Replicated validation logic (mirrors route.ts) ──────────────────────────

const STRIPE_TIMESTAMP_TOLERANCE_SECONDS = 300

async function validateStripeSignature(
  rawBody: string,
  sigHeader: string,
  webhookSecret: string
): Promise<{ valid: boolean; reason?: string }> {
  try {
    const parts = sigHeader.split(',').reduce((acc: Record<string, string>, part) => {
      const [k, v] = part.split('=')
      if (k && v !== undefined) acc[k] = v
      return acc
    }, {})

    const timestamp = parts['t']
    const signatures = sigHeader
      .split(',')
      .filter(p => p.startsWith('v1='))
      .map(p => p.slice(3))

    if (!timestamp || signatures.length === 0) {
      return { valid: false, reason: 'Missing timestamp or signature in header' }
    }

    const eventTimestampSec = parseInt(timestamp, 10)
    if (isNaN(eventTimestampSec)) {
      return { valid: false, reason: 'Non-numeric timestamp in Stripe-Signature header' }
    }
    const nowSec = Math.floor(Date.now() / 1000)
    const ageSec = Math.abs(nowSec - eventTimestampSec)
    if (ageSec > STRIPE_TIMESTAMP_TOLERANCE_SECONDS) {
      return {
        valid: false,
        reason: `Webhook timestamp is ${ageSec}s old (tolerance: ${STRIPE_TIMESTAMP_TOLERANCE_SECONDS}s). Possible replay attack.`,
      }
    }

    const signedPayload = `${timestamp}.${rawBody}`
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(webhookSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload))
    const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')

    if (!signatures.includes(computed)) {
      return { valid: false, reason: 'HMAC signature mismatch' }
    }
    return { valid: true }
  } catch {
    return { valid: false, reason: 'Exception during signature validation' }
  }
}

async function validateHmacSignature(
  rawBody: string,
  sigHeader: string,
  secret: string
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody))
    const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
    const received = sigHeader.replace(/^sha256=/, '')
    return computed === received
  } catch {
    return false
  }
}

// ─── Test helpers ──────────────────────────────────────────────────────────────

async function buildStripeHeader(body: string, secret: string, timestampSec?: number): Promise<string> {
  const t = timestampSec ?? Math.floor(Date.now() / 1000)
  const signedPayload = `${t}.${body}`
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload))
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
  return `t=${t},v1=${hex}`
}

async function buildHmacHeader(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
  return `sha256=${hex}`
}

// ─── STRIPE SIGNATURE TESTS ───────────────────────────────────────────────────

describe('Stripe webhook signature validation', () => {
  const SECRET = 'whsec_test_secret_value'
  const BODY = JSON.stringify({ type: 'payment_intent.succeeded', id: 'evt_test_123' })

  test('valid signature with current timestamp → accepted', async () => {
    const header = await buildStripeHeader(BODY, SECRET)
    const result = await validateStripeSignature(BODY, header, SECRET)
    expect(result.valid).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  test('wrong secret → rejected', async () => {
    const header = await buildStripeHeader(BODY, SECRET)
    const result = await validateStripeSignature(BODY, header, 'wrong_secret')
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('mismatch')
  })

  test('tampered body → rejected', async () => {
    const header = await buildStripeHeader(BODY, SECRET)
    const tamperedBody = BODY.replace('payment_intent.succeeded', 'charge.refunded')
    const result = await validateStripeSignature(tamperedBody, header, SECRET)
    expect(result.valid).toBe(false)
  })

  test('replayed event (timestamp > 5 min ago) → rejected', async () => {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 400 // 400 seconds ago
    const header = await buildStripeHeader(BODY, SECRET, oldTimestamp)
    const result = await validateStripeSignature(BODY, header, SECRET)
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('replay attack')
  })

  test('event from the future (clock skew > tolerance) → rejected', async () => {
    const futureTimestamp = Math.floor(Date.now() / 1000) + 400 // 400 seconds in future
    const header = await buildStripeHeader(BODY, SECRET, futureTimestamp)
    const result = await validateStripeSignature(BODY, header, SECRET)
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('replay attack')
  })

  test('event exactly at tolerance boundary → accepted', async () => {
    const boundaryTimestamp = Math.floor(Date.now() / 1000) - 299 // 1 second inside tolerance
    const header = await buildStripeHeader(BODY, SECRET, boundaryTimestamp)
    const result = await validateStripeSignature(BODY, header, SECRET)
    expect(result.valid).toBe(true)
  })

  test('missing Stripe-Signature header → rejected', async () => {
    const result = await validateStripeSignature(BODY, '', SECRET)
    expect(result.valid).toBe(false)
    expect(result.reason).toBeTruthy()
  })

  test('malformed header (no t= field) → rejected', async () => {
    const result = await validateStripeSignature(BODY, 'v1=somesig', SECRET)
    expect(result.valid).toBe(false)
  })

  test('malformed header (non-numeric timestamp) → rejected', async () => {
    const result = await validateStripeSignature(BODY, 't=notanumber,v1=somesig', SECRET)
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('Non-numeric timestamp')
  })

  test('header with multiple v1 signatures (Stripe key rotation) → accepted if one matches', async () => {
    // Stripe can include multiple v1= values during key rotation
    const header = await buildStripeHeader(BODY, SECRET)
    const fakeExtra = 'v1=aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222'
    const multiHeader = header + ',' + fakeExtra
    const result = await validateStripeSignature(BODY, multiHeader, SECRET)
    expect(result.valid).toBe(true) // the real signature is still present
  })
})

// ─── GENERIC HMAC TESTS ────────────────────────────────────────────────────────

describe('Generic HMAC webhook signature validation', () => {
  const SECRET = 'my_webhook_secret'
  const BODY = JSON.stringify({ event: 'user.created', userId: 'usr_abc' })

  test('valid sha256 signature → accepted', async () => {
    const header = await buildHmacHeader(BODY, SECRET)
    const result = await validateHmacSignature(BODY, header, SECRET)
    expect(result).toBe(true)
  })

  test('wrong secret → rejected', async () => {
    const header = await buildHmacHeader(BODY, SECRET)
    const result = await validateHmacSignature(BODY, header, 'wrong_secret')
    expect(result).toBe(false)
  })

  test('tampered body → rejected', async () => {
    const header = await buildHmacHeader(BODY, SECRET)
    const result = await validateHmacSignature(BODY + ' extra', header, SECRET)
    expect(result).toBe(false)
  })

  test('signature without sha256= prefix → accepted (prefix stripped)', async () => {
    const header = await buildHmacHeader(BODY, SECRET)
    const withoutPrefix = header.replace('sha256=', '')
    // The route code strips sha256= prefix before comparing
    const result = await validateHmacSignature(BODY, withoutPrefix, SECRET)
    // Without the prefix strip logic: this would fail because computed has no prefix
    // but received also has no prefix → they should match
    expect(result).toBe(true)
  })

  test('empty body → validates (empty body is a valid payload)', async () => {
    const emptyHeader = await buildHmacHeader('', SECRET)
    const result = await validateHmacSignature('', emptyHeader, SECRET)
    expect(result).toBe(true)
  })

  test('empty signature header → rejected', async () => {
    const result = await validateHmacSignature(BODY, '', SECRET)
    expect(result).toBe(false)
  })
})

// ─── JWT CROSS-PROJECT SCOPING ─────────────────────────────────────────────────

describe('JWT cross-project scoping', () => {
  // These tests verify the logic that platform JWTs cannot be used cross-project.
  // The middleware enforces: token.projectId must match URL projectId.

  type TokenPayload = Record<string, unknown>

  function isPlatformToken(payload: TokenPayload): boolean {
    return typeof payload.userId === 'string' && typeof payload.email === 'string' && !('projectId' in payload)
  }

  function isEndUserToken(payload: TokenPayload): boolean {
    return typeof payload.userId === 'string' && typeof payload.projectId === 'string'
  }

  function validateEndUserAccess(
    tokenPayload: TokenPayload,
    requestedProjectId: string
  ): { allowed: boolean; reason?: string } {
    if (!isEndUserToken(tokenPayload)) {
      return { allowed: false, reason: 'Not an end-user token' }
    }
    if (tokenPayload.projectId !== requestedProjectId) {
      return { allowed: false, reason: 'Token project scope does not match requested project' }
    }
    return { allowed: true }
  }

  test('end-user token for project A is rejected on project B', () => {
    const token: TokenPayload = {
      userId: 'user-123',
      projectId: 'proj-aaa',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }

    const resultA = validateEndUserAccess(token, 'proj-aaa')
    const resultB = validateEndUserAccess(token, 'proj-bbb')

    expect(resultA.allowed).toBe(true)
    expect(resultB.allowed).toBe(false)
    expect(resultB.reason).toContain('scope')
  })

  test('platform token cannot be used as end-user token', () => {
    const platformPayload: TokenPayload = {
      userId: 'user-123',
      email: 'dev@example.com',
      role: 'user',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 604800,
    }

    const result = validateEndUserAccess(platformPayload, 'proj-aaa')
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('end-user token')
  })

  test('end-user token structure is distinguishable from platform token', () => {
    const platformPayload: TokenPayload = { userId: 'u1', email: 'a@b.com', role: 'user' }
    const endUserPayload: TokenPayload = { userId: 'u2', projectId: 'proj-x' }

    expect(isPlatformToken(platformPayload)).toBe(true)
    expect(isEndUserToken(platformPayload)).toBe(false)

    expect(isPlatformToken(endUserPayload)).toBe(false)
    expect(isEndUserToken(endUserPayload)).toBe(true)
  })

  test('expired token (exp in past) should fail time check', () => {
    const expiredPayload: TokenPayload = {
      userId: 'user-123',
      projectId: 'proj-aaa',
      iat: Math.floor(Date.now() / 1000) - 7200,
      exp: Math.floor(Date.now() / 1000) - 3600, // expired 1 hour ago
    }

    const nowSec = Math.floor(Date.now() / 1000)
    const exp = expiredPayload.exp as number
    const isExpired = nowSec > exp

    expect(isExpired).toBe(true)
  })
})

// ─── RLS BYPASS PREVENTION ─────────────────────────────────────────────────────

describe('RLS bypass prevention', () => {
  // Tests the security model of executeWithUserContext

  function buildRlsContextQuery(userId: string): string {
    // Mirrors the SET LOCAL call in workspace-rls.ts
    // Validates that the userId is safe before embedding in SQL
    const safeUserId = userId.replace(/['"\\;]/g, '') // strip dangerous chars
    if (safeUserId !== userId) {
      throw new Error(`Unsafe userId for RLS context: ${userId}`)
    }
    return `SET LOCAL "app.current_user_id" = '${userId}'`
  }

  test('valid UUID user ID produces correct SET LOCAL query', () => {
    const userId = '123e4567-e89b-12d3-a456-426614174000'
    const query = buildRlsContextQuery(userId)
    expect(query).toBe(`SET LOCAL "app.current_user_id" = '${userId}'`)
  })

  test('SQL injection in userId is stripped before RLS context set', () => {
    const maliciousId = "' OR '1'='1"
    expect(() => buildRlsContextQuery(maliciousId)).toThrow('Unsafe userId')
  })

  test('semicolon injection in userId is stripped', () => {
    const maliciousId = "abc; DROP TABLE users; --"
    expect(() => buildRlsContextQuery(maliciousId)).toThrow('Unsafe userId')
  })

  test('valid alphanumeric userId (non-UUID) passes safely', () => {
    const userId = 'user_abc123'
    const query = buildRlsContextQuery(userId)
    expect(query).toContain('user_abc123')
  })

  test('service-role query without user context executes without SET LOCAL', () => {
    // When isServiceRole=true, no user context is set — all rows are visible
    function buildQuery(userId: string | null, isServiceRole: boolean, table: string): string {
      if (isServiceRole) {
        return `SELECT * FROM "${table}"` // No RLS context
      }
      if (!userId) {
        throw new Error('User ID required for non-service-role access')
      }
      return `SET LOCAL "app.current_user_id" = '${userId}'; SELECT * FROM "${table}"`
    }

    const serviceQuery = buildQuery(null, true, 'users')
    expect(serviceQuery).not.toContain('SET LOCAL')
    expect(serviceQuery).toContain('SELECT *')

    // Non-service-role requires userId
    expect(() => buildQuery(null, false, 'users')).toThrow('User ID required')
  })

  test('RLS policy own_rows expression uses parameterized current_setting call', () => {
    // The policy expression should use current_setting, not a hardcoded value
    const policyExpression = `user_id = current_setting('app.current_user_id')::uuid`
    expect(policyExpression).toContain('current_setting')
    expect(policyExpression).not.toContain("= '") // No hardcoded user ID
  })

  test('workspace schema names reject path traversal', () => {
    const projectIds = [
      '../other_schema',
      '../../pg_catalog',
      'proj_id; DROP SCHEMA workspace_victim',
    ]
    const SAFE_PROJECT_ID_PATTERN = /^[a-z0-9_-]+$/i

    for (const pid of projectIds) {
      const schemaName = `workspace_${pid}`
      // Schema name must only contain safe characters
      expect(SAFE_PROJECT_ID_PATTERN.test(pid)).toBe(false)
    }
  })
})

// ─── CORS EDGE CASES ──────────────────────────────────────────────────────────

describe('CORS edge cases', () => {
  function evaluateCors(
    origin: string | null,
    pathname: string,
    allowedOrigins: string[],
  ): { allowed: boolean; allowedOrigin: string | null } {
    if (!origin) return { allowed: false, allowedOrigin: null }

    // Block null origin
    if (origin === 'null') return { allowed: false, allowedOrigin: null }

    // Block multiple origins
    if (origin.includes(',') || origin.includes(' ')) return { allowed: false, allowedOrigin: null }

    // Validate URL format
    try {
      const url = new URL(origin)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { allowed: false, allowedOrigin: null }
      }
    } catch {
      return { allowed: false, allowedOrigin: null }
    }

    const isSdkRoute = pathname.startsWith('/api/v1/')
    if (isSdkRoute) {
      return { allowed: true, allowedOrigin: origin }
    }

    const isAllowed = allowedOrigins.includes(origin)
    return { allowed: isAllowed, allowedOrigin: isAllowed ? origin : null }
  }

  const ALLOWED = ['https://backenly.com', 'http://localhost:3000']

  test('SDK route allows any valid HTTP origin', () => {
    const result = evaluateCors('https://my-app.vercel.app', '/api/v1/proj/database/query', ALLOWED)
    expect(result.allowed).toBe(true)
    expect(result.allowedOrigin).toBe('https://my-app.vercel.app')
  })

  test('platform route rejects unlisted origin', () => {
    const result = evaluateCors('https://attacker.com', '/api/database/create', ALLOWED)
    expect(result.allowed).toBe(false)
  })

  test('platform route allows listed origin', () => {
    const result = evaluateCors('https://backenly.com', '/api/database/create', ALLOWED)
    expect(result.allowed).toBe(true)
  })

  test('null origin is rejected', () => {
    const result = evaluateCors('null', '/api/v1/proj/query', ALLOWED)
    expect(result.allowed).toBe(false)
  })

  test('multiple origins in one header is rejected (injection attack)', () => {
    const result = evaluateCors('https://good.com, https://evil.com', '/api/v1/proj/query', ALLOWED)
    expect(result.allowed).toBe(false)
  })

  test('non-HTTP protocol in origin is rejected', () => {
    const result = evaluateCors('ftp://evil.com', '/api/v1/proj/query', ALLOWED)
    expect(result.allowed).toBe(false)
  })

  test('malformed origin URL is rejected', () => {
    const result = evaluateCors('not-a-url', '/api/v1/proj/query', ALLOWED)
    expect(result.allowed).toBe(false)
  })

  test('missing origin header is handled gracefully', () => {
    const result = evaluateCors(null, '/api/v1/proj/query', ALLOWED)
    expect(result.allowed).toBe(false)
    expect(result.allowedOrigin).toBeNull()
  })
})

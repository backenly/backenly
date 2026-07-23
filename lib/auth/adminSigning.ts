/**
 * ADMIN REQUEST SIGNING
 * =====================
 * Provides HMAC-SHA256 request signing for admin/destructive endpoints so that
 * a stolen JWT alone is not sufficient to call them.
 *
 * How it works:
 *   Client signs: HMAC-SHA256(timestamp + "." + method + "." + path + "." + bodyHash, ADMIN_SECRET)
 *   Server re-computes the same signature and verifies with timingSafeEqual.
 *
 * Headers the client must send:
 *   X-Admin-Timestamp  — Unix seconds (UTC), must be within CLOCK_SKEW_SEC of server time
 *   X-Admin-Signature  — hex-encoded HMAC-SHA256
 *
 * The ADMIN_SIGNING_SECRET env var must be set. In production, use a different
 * value than JWT_SECRET so compromising one does not compromise the other.
 *
 * Usage:
 *   // In route handler:
 *   import { requireAdminSignature } from '@/lib/auth/adminSigning'
 *   const check = await requireAdminSignature(request)
 *   if (check) return check  // returns 401/403 NextResponse on failure
 *
 *   // In client code (TypeScript):
 *   import { signAdminRequest } from '@/lib/auth/adminSigning'
 *   const { timestamp, signature } = await signAdminRequest(method, path, body, ADMIN_SECRET)
 */

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'

// Maximum allowed clock skew between client and server (seconds)
const CLOCK_SKEW_SEC = 300  // 5 minutes

/**
 * Compute the canonical string that is signed.
 * Format: {timestamp}.{METHOD}.{path}.{bodyHash}
 * where bodyHash is SHA-256 of the raw request body (or "empty" if no body).
 */
function buildSigningString(
  timestamp: string,
  method: string,
  path: string,
  bodyHash: string
): string {
  return `${timestamp}.${method.toUpperCase()}.${path}.${bodyHash}`
}

function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function hmacSha256Hex(secret: string, message: string): string {
  return crypto.createHmac('sha256', secret).update(message).digest('hex')
}

/**
 * Server-side: verify the HMAC admin signature on an incoming request.
 * Returns null on success, or a NextResponse with an appropriate error status.
 */
export async function requireAdminSignature(
  request: NextRequest
): Promise<NextResponse | null> {
  const signingSecret = process.env.ADMIN_SIGNING_SECRET
  if (!signingSecret) {
    console.error('[AdminSigning] ADMIN_SIGNING_SECRET is not set — admin signing enforcement disabled')
    // Fail open only in development; in production, reject
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json(
        { error: 'Server misconfiguration: admin signing secret not configured' },
        { status: 503 }
      )
    }
    return null
  }

  const timestampHeader = request.headers.get('x-admin-timestamp')
  const signatureHeader = request.headers.get('x-admin-signature')

  if (!timestampHeader || !signatureHeader) {
    return NextResponse.json(
      { error: 'Admin requests require X-Admin-Timestamp and X-Admin-Signature headers' },
      { status: 401 }
    )
  }

  const timestamp = parseInt(timestampHeader, 10)
  if (isNaN(timestamp)) {
    return NextResponse.json(
      { error: 'Invalid X-Admin-Timestamp: must be a Unix timestamp in seconds' },
      { status: 400 }
    )
  }

  // Replay protection: reject requests older than CLOCK_SKEW_SEC
  const nowSec = Math.floor(Date.now() / 1000)
  const ageSec = Math.abs(nowSec - timestamp)
  if (ageSec > CLOCK_SKEW_SEC) {
    return NextResponse.json(
      { error: `Request timestamp too old or too far in the future (${ageSec}s skew, tolerance: ${CLOCK_SKEW_SEC}s)` },
      { status: 401 }
    )
  }

  // Read body to hash it — clone the request so the body can be consumed again
  let bodyHash: string
  try {
    const bodyBuffer = await request.arrayBuffer()
    bodyHash = sha256Hex(Buffer.from(bodyBuffer).toString('utf8') || 'empty')
  } catch {
    bodyHash = sha256Hex('empty')
  }

  const { pathname } = request.nextUrl
  const signingString = buildSigningString(timestampHeader, request.method, pathname, bodyHash)
  const expectedSig = hmacSha256Hex(signingSecret, signingString)

  // Timing-safe comparison
  const receivedBuf = Buffer.from(signatureHeader.padEnd(expectedSig.length, '0').slice(0, expectedSig.length), 'hex')
  const expectedBuf = Buffer.from(expectedSig, 'hex')

  if (receivedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(receivedBuf, expectedBuf)) {
    console.warn(`[AdminSigning] Signature mismatch for ${request.method} ${pathname}`)
    return NextResponse.json(
      { error: 'Invalid admin signature. The request may have been tampered with or the signing secret is wrong.' },
      { status: 403 }
    )
  }

  return null  // Signature valid
}

/**
 * Client-side helper: compute the signature headers for an admin request.
 * Use this in the dashboard's API client when calling admin endpoints.
 *
 * @param method  HTTP method (e.g. 'DELETE')
 * @param path    Request path (e.g. '/api/admin/users/123')
 * @param body    Request body as a string (or undefined for GET/DELETE with no body)
 * @param secret  ADMIN_SIGNING_SECRET — never expose this in client-side code!
 *                Only use this function in server-side Next.js routes or scripts.
 */
export function signAdminRequest(
  method: string,
  path: string,
  body: string | undefined,
  secret: string
): { 'X-Admin-Timestamp': string; 'X-Admin-Signature': string } {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const bodyHash = sha256Hex(body ?? 'empty')
  const signingString = buildSigningString(timestamp, method, path, bodyHash)
  const signature = hmacSha256Hex(secret, signingString)
  return {
    'X-Admin-Timestamp': timestamp,
    'X-Admin-Signature': signature,
  }
}

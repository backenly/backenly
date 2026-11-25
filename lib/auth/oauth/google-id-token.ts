/**
 * A GOOGLE ID TOKEN, PROVEN BEFORE IT IS READ
 * ===========================================
 * Google One Tap hands the browser an ID token (a JWT) and the browser posts
 * it to us. Anybody can post anything, so nothing in it is believed until:
 *
 *   - its signature verifies against one of Google's published keys (RS256
 *     only, so a token naming another algorithm is refused);
 *   - it was issued by Google (`iss`);
 *   - it was issued FOR THIS DEPLOYMENT (`aud` is our own client id). Without
 *     this, a token a person gave to any other site that uses Google sign-in
 *     would sign that site's owner into the person's account here;
 *   - it has not expired.
 *
 * Returns the claims, or null. Null means refuse the sign-in.
 */

import { createPublicKey, type KeyObject } from 'crypto'
import { decode, verify } from 'jsonwebtoken'

const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs'
const ISSUERS: [string, string] = ['https://accounts.google.com', 'accounts.google.com']
/** Google rotates keys every few days and publishes the next one in advance. */
const KEYS_MAX_AGE_MS = 60 * 60_000
/** An unknown key id refetches, but not on every request a stranger sends. */
const REFETCH_FLOOR_MS = 60_000

export interface GoogleIdTokenClaims {
  sub: string
  email?: string
  email_verified?: boolean | string
  name?: string
  [claim: string]: unknown
}

let keys: Map<string, KeyObject> = new Map()
let fetchedAt = 0

async function loadKeys(): Promise<void> {
  const res = await fetch(GOOGLE_CERTS, { signal: AbortSignal.timeout(5_000) })
  if (!res.ok) throw new Error(`Google certs returned ${res.status}`)
  const body = (await res.json()) as { keys?: Array<{ kid?: string; kty?: string } & Record<string, unknown>> }
  const next = new Map<string, KeyObject>()
  for (const jwk of body.keys ?? []) {
    if (!jwk.kid || jwk.kty !== 'RSA') continue
    next.set(jwk.kid, createPublicKey({ key: jwk as any, format: 'jwk' }))
  }
  if (next.size === 0) throw new Error('Google certs held no RSA key')
  keys = next
  fetchedAt = Date.now()
}

async function keyFor(kid: string): Promise<KeyObject | null> {
  const age = Date.now() - fetchedAt
  if (age > KEYS_MAX_AGE_MS || (!keys.has(kid) && age > REFETCH_FLOOR_MS)) {
    try {
      await loadKeys()
    } catch (error) {
      console.error('[Google ID token] Could not load signing keys:', (error as Error)?.message || 'Error')
      // Keys already held stay usable; a token they do not cover is refused.
    }
  }
  return keys.get(kid) ?? null
}

export async function verifyGoogleIdToken(credential: unknown, clientId: string): Promise<GoogleIdTokenClaims | null> {
  if (typeof credential !== 'string' || credential.length === 0 || credential.length > 8192) return null
  if (!clientId) return null

  const header = decode(credential, { complete: true })?.header
  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string') return null

  const key = await keyFor(header.kid)
  if (!key) return null

  try {
    const claims = verify(credential, key, {
      algorithms: ['RS256'],
      audience: clientId,
      issuer: ISSUERS,
    })
    if (typeof claims !== 'object' || claims === null) return null
    if (typeof claims.sub !== 'string' || claims.sub.length === 0) return null
    return claims as GoogleIdTokenClaims
  } catch {
    return null
  }
}

/** For tests: forget the keys held in memory. */
export function forgetGoogleSigningKeys(): void {
  keys = new Map()
  fetchedAt = 0
}

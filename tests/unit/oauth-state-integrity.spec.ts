/**
 * OAuth state must be unforgeable, and a token must never leave to an origin
 * the project has not claimed.
 *
 * ── The vulnerability ───────────────────────────────────────────────────────
 *
 * End-user OAuth (Google/GitHub/Discord/Facebook) carried its state as plain
 * base64 of `{ projectId, nonce, redirect_to }`. The callback validated exactly
 * one field — that `projectId` matched the URL it had been called on — which an
 * attacker satisfies for free, because projectId IS the URL they are attacking.
 * The nonce was generated and never stored, compared or checked by anything.
 *
 * So the state was forgeable, and the callback ended with:
 *
 *     redirectUrl.searchParams.set('token', token)   // the end-user's JWT
 *     return res.redirect(redirectUrl.toString())
 *
 * pointed at a URL read straight out of it. Forge a state carrying
 * `redirect_to: https://evil.example`, walk any end-user of any OAuth-enabled
 * project through it, and their project-scoped JWT arrives at the attacker's
 * server as a query parameter — plus their access log, the referrer header, and
 * the victim's browser history.
 *
 * Two independent defences, because either alone leaves a hole: the state is
 * HMAC-signed per project with an expiry, and the redirect target is checked
 * against `ConnectedApp` — the project's own list of connected frontends.
 */

import { signState, verifyState, resolveRedirectTarget } from '@/server/routes/oauth'

const PROJECT = '7e65d1a8-38d1-4130-9cef-48bdf5a5d370'
const OTHER_PROJECT = 'ce18214a-51bc-42cf-8b69-ffaf495234b0'
const SECRET = 'a'.repeat(48)
const OTHER_SECRET = 'b'.repeat(48)

const connectedOrigins: string[] = []
jest.mock('@/lib/db', () => ({
  prisma: {
    connectedApp: {
      findMany: async () => connectedOrigins.map(origin => ({ origin })),
    },
  },
}))

jest.mock('@/lib/services/jwtSecretManager', () => ({
  resolveJwtSecret: (s: string) => s,
}))

const freshState = (over: Partial<Record<string, unknown>> = {}) => ({
  projectId: PROJECT,
  nonce: 'n',
  redirect_to: 'https://app.example.com/cb',
  iat: Date.now(),
  ...over,
}) as any

describe('OAuth state is unforgeable', () => {
  it('round-trips a state it signed itself', () => {
    const s = signState(freshState(), SECRET)
    const out = verifyState(s, PROJECT, SECRET)
    expect(out).toBeTruthy()
    expect(out!.redirect_to).toBe('https://app.example.com/cb')
  })

  it('REJECTS the pre-fix format — plain base64 with no signature', () => {
    // Exactly what an attacker used to be able to mint by hand.
    const forged = Buffer.from(
      JSON.stringify({ projectId: PROJECT, nonce: 'whatever', redirect_to: 'https://evil.example' }),
    ).toString('base64url')
    expect(verifyState(forged, PROJECT, SECRET)).toBeNull()
  })

  it('REJECTS a tampered payload that keeps the original signature', () => {
    const good = signState(freshState(), SECRET)
    const sig = good.slice(good.lastIndexOf('.') + 1)
    const evil = Buffer.from(
      JSON.stringify(freshState({ redirect_to: 'https://evil.example' })),
    ).toString('base64url')
    expect(verifyState(`${evil}.${sig}`, PROJECT, SECRET)).toBeNull()
  })

  it('REJECTS a state signed with another project\'s secret', () => {
    const s = signState(freshState(), OTHER_SECRET)
    expect(verifyState(s, PROJECT, SECRET)).toBeNull()
  })

  it('REJECTS a valid state replayed against a different project', () => {
    const s = signState(freshState(), SECRET)
    expect(verifyState(s, OTHER_PROJECT, SECRET)).toBeNull()
  })

  it('REJECTS an expired state, so a captured one is not reusable forever', () => {
    const s = signState(freshState({ iat: Date.now() - 11 * 60 * 1000 }), SECRET)
    expect(verifyState(s, PROJECT, SECRET)).toBeNull()
  })

  it('REJECTS a state with no iat rather than treating it as fresh', () => {
    const s = signState({ projectId: PROJECT, nonce: 'n' } as any, SECRET)
    expect(verifyState(s, PROJECT, SECRET)).toBeNull()
  })

  it('REJECTS malformed input without throwing', () => {
    for (const bad of ['', '.', 'nodot', 'a.b', '....', 'x'.repeat(500)]) {
      expect(() => verifyState(bad, PROJECT, SECRET)).not.toThrow()
      expect(verifyState(bad, PROJECT, SECRET)).toBeNull()
    }
  })
})

describe('a token only ever leaves to a connected frontend', () => {
  beforeEach(() => { connectedOrigins.length = 0 })

  it('allows an exactly-matching connected origin', async () => {
    connectedOrigins.push('https://app.example.com')
    const out = await resolveRedirectTarget(PROJECT, 'https://app.example.com/callback?x=1')
    expect(out && 'url' in out).toBe(true)
  })

  it('REFUSES an origin the project never connected', async () => {
    connectedOrigins.push('https://app.example.com')
    const out = await resolveRedirectTarget(PROJECT, 'https://evil.example/steal')
    expect(out && 'rejected' in out).toBe(true)
  })

  it('REFUSES a lookalike that would pass a suffix check', async () => {
    // The classic allowlist failure: endsWith('.example.com') is satisfied by
    // evil-example.com, and `https://app.example.com.evil.io` is satisfied by
    // a naive `includes`. Origin comparison is exact.
    connectedOrigins.push('https://app.example.com')
    for (const bad of [
      'https://app.example.com.evil.io/cb',
      'https://evil-app.example.com/cb',
      'https://notapp.example.com/cb',
      'https://app.example.com.attacker.test/cb',
    ]) {
      const out = await resolveRedirectTarget(PROJECT, bad)
      expect(out && 'rejected' in out).toBe(true)
    }
  })

  it('REFUSES a different port on an allowed host', async () => {
    connectedOrigins.push('https://app.example.com')
    const out = await resolveRedirectTarget(PROJECT, 'https://app.example.com:8443/cb')
    expect(out && 'rejected' in out).toBe(true)
  })

  it('REFUSES plaintext http, which would put the token on the wire', async () => {
    connectedOrigins.push('http://app.example.com')
    const out = await resolveRedirectTarget(PROJECT, 'http://app.example.com/cb')
    expect(out && 'rejected' in out).toBe(true)
  })

  it('allows http on localhost, where every first integration runs', async () => {
    connectedOrigins.push('http://localhost:3000')
    const out = await resolveRedirectTarget(PROJECT, 'http://localhost:3000/cb')
    expect(out && 'url' in out).toBe(true)
  })

  it('REFUSES non-http schemes outright', async () => {
    connectedOrigins.push('https://app.example.com')
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
      const out = await resolveRedirectTarget(PROJECT, bad)
      expect(out && 'rejected' in out).toBe(true)
    }
  })

  it('REFUSES garbage rather than throwing mid-callback', async () => {
    connectedOrigins.push('https://app.example.com')
    const out = await resolveRedirectTarget(PROJECT, 'not a url')
    expect(out && 'rejected' in out).toBe(true)
  })

  it('returns null when no redirect was asked for — the token stays in the body', async () => {
    expect(await resolveRedirectTarget(PROJECT, undefined)).toBeNull()
    expect(await resolveRedirectTarget(PROJECT, '')).toBeNull()
  })

  it('tolerates a stored origin with a trailing slash', async () => {
    connectedOrigins.push('https://app.example.com/')
    const out = await resolveRedirectTarget(PROJECT, 'https://app.example.com/cb')
    expect(out && 'url' in out).toBe(true)
  })
})

describe('the two defences are independent', () => {
  beforeEach(() => { connectedOrigins.length = 0 })

  it('a correctly SIGNED state still cannot redirect somewhere unconnected', async () => {
    // Signing proves the platform minted it. It does not prove the destination
    // is one this project owns — the owner supplies redirect_to on the way in.
    connectedOrigins.push('https://app.example.com')
    const s = signState(freshState({ redirect_to: 'https://evil.example' }), SECRET)
    const state = verifyState(s, PROJECT, SECRET)
    expect(state).toBeTruthy()
    const out = await resolveRedirectTarget(PROJECT, state!.redirect_to)
    expect(out && 'rejected' in out).toBe(true)
  })
})

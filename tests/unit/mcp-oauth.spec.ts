/**
 * MCP OAuth — the checks that are load-bearing for security.
 *
 * Each block here corresponds to a way the flow could be broken open, not to a
 * function that happens to exist. The most important one by far is the token
 * confusion test: platform session JWTs are HS256 signed with the SAME
 * JWT_SECRET as MCP access tokens, so without a required `typ` claim a stolen
 * dashboard cookie would authenticate as an MCP credential. That is a
 * privilege escalation from "read the user's browser" to "drive their backend",
 * and nothing about the signature would look wrong.
 */

import crypto from 'crypto'
import jwt from 'jsonwebtoken'

import {
  ACCESS_TOKEN_TYP,
  appOrigin,
  isAcceptableRedirectUri,
  isRegisteredRedirect,
  mcpResourceUrl,
  mintAccessToken,
  scopeAllowsWrite,
  verifyAccessToken,
  verifyPkce,
} from '@/lib/mcp/oauth'
import { CONFIRM_TYP, REQ_TYP, signAuthzToken, verifyAuthzToken } from '@/lib/mcp/oauth-authz'
import { generateToken } from '@/lib/auth/jwt'

const challengeFor = (verifier: string) =>
  crypto.createHash('sha256').update(verifier).digest('base64url')

const VERIFIER = 'a'.repeat(64)

describe('PKCE', () => {
  it('accepts a correct S256 verifier', () => {
    expect(verifyPkce(VERIFIER, challengeFor(VERIFIER))).toBe(true)
  })

  it('rejects a wrong verifier', () => {
    expect(verifyPkce('b'.repeat(64), challengeFor(VERIFIER))).toBe(false)
  })

  it('rejects the plain method, which would make PKCE a no-op', () => {
    // If `plain` were honoured the challenge would equal the verifier, so
    // anyone who intercepted the redirect could redeem the code.
    const challenge = VERIFIER
    expect(verifyPkce(VERIFIER, challenge)).toBe(false)
  })

  it('enforces the RFC 7636 length bounds', () => {
    const short = 'a'.repeat(42)
    const long = 'a'.repeat(129)
    expect(verifyPkce(short, challengeFor(short))).toBe(false)
    expect(verifyPkce(long, challengeFor(long))).toBe(false)
  })

  it('rejects empty input rather than treating it as a match', () => {
    expect(verifyPkce('', '')).toBe(false)
    expect(verifyPkce(VERIFIER, '')).toBe(false)
  })
})

describe('access tokens', () => {
  const mint = () =>
    mintAccessToken({
      apiKeyId: 'key-1',
      projectId: 'proj-1',
      clientId: 'mcpc_test',
      scope: 'mcp:read mcp:write',
    }).token

  it('round-trips with the expected claims', () => {
    const claims = verifyAccessToken(mint())
    expect(claims).not.toBeNull()
    expect(claims!.sub).toBe('key-1')
    expect(claims!.project_id).toBe('proj-1')
    expect(claims!.typ).toBe(ACCESS_TOKEN_TYP)
    expect(claims!.aud).toBe(mcpResourceUrl())
    expect(claims!.iss).toBe(appOrigin())
  })

  it('REFUSES a platform session JWT signed with the same secret', () => {
    // The whole reason `typ` is required. This token verifies cryptographically.
    const platform = generateToken({ userId: 'user-1', email: 'a@b.c' })
    expect(verifyAccessToken(platform)).toBeNull()
  })

  it('refuses a token forged with the wrong secret', () => {
    const forged = jwt.sign({ typ: ACCESS_TOKEN_TYP, sub: 'key-1', project_id: 'p' }, 'not-the-secret', {
      algorithm: 'HS256',
      issuer: appOrigin(),
      audience: mcpResourceUrl(),
    })
    expect(verifyAccessToken(forged)).toBeNull()
  })

  it('refuses a token minted for a different resource', () => {
    const otherAud = jwt.sign(
      { typ: ACCESS_TOKEN_TYP, sub: 'key-1', project_id: 'p' },
      process.env.JWT_SECRET!,
      { algorithm: 'HS256', issuer: appOrigin(), audience: 'https://someone-else.example/mcp' },
    )
    expect(verifyAccessToken(otherAud)).toBeNull()
  })

  it('refuses an expired token', () => {
    const expired = jwt.sign(
      { typ: ACCESS_TOKEN_TYP, sub: 'key-1', project_id: 'p' },
      process.env.JWT_SECRET!,
      { algorithm: 'HS256', issuer: appOrigin(), audience: mcpResourceUrl(), expiresIn: -10 },
    )
    expect(verifyAccessToken(expired)).toBeNull()
  })
})

describe('scope', () => {
  it('treats a read-only grant as non-writing', () => {
    expect(scopeAllowsWrite('mcp:read')).toBe(false)
  })

  it('recognises a write grant', () => {
    expect(scopeAllowsWrite('mcp:read mcp:write')).toBe(true)
  })

  it('treats a missing scope as non-writing', () => {
    // Fail closed: an absent scope must never imply write.
    expect(scopeAllowsWrite(undefined)).toBe(false)
    expect(scopeAllowsWrite('')).toBe(false)
  })
})

describe('redirect URIs', () => {
  it('matches only exactly, so a suffix cannot impersonate a prefix', () => {
    const registered = ['http://localhost:8080/callback']
    expect(isRegisteredRedirect('http://localhost:8080/callback', registered)).toBe(true)
    expect(isRegisteredRedirect('http://localhost:8080/callback.evil.com', registered)).toBe(false)
    expect(isRegisteredRedirect('http://localhost:8080/callback/../x', registered)).toBe(false)
  })

  it('accepts https anywhere and http only on loopback', () => {
    expect(isAcceptableRedirectUri('https://cursor.sh/cb')).toBe(true)
    expect(isAcceptableRedirectUri('http://localhost:1234/cb')).toBe(true)
    expect(isAcceptableRedirectUri('http://127.0.0.1:1234/cb')).toBe(true)
    // Plain http off-loopback would put an authorization code on the wire.
    expect(isAcceptableRedirectUri('http://evil.example/cb')).toBe(false)
  })

  it('rejects custom schemes and fragments', () => {
    expect(isAcceptableRedirectUri('myapp://cb')).toBe(false)
    expect(isAcceptableRedirectUri('https://ok.example/cb#frag')).toBe(false)
    expect(isAcceptableRedirectUri('not a url')).toBe(false)
  })
})

describe('authorization round-trip tokens', () => {
  const base = {
    client_id: 'mcpc_test',
    redirect_uri: 'http://localhost:9/cb',
    code_challenge: challengeFor(VERIFIER),
    scope: 'mcp:read',
  }

  it('round-trips a request token', () => {
    const t = signAuthzToken(base, REQ_TYP)
    expect(verifyAuthzToken(t, REQ_TYP)?.client_id).toBe('mcpc_test')
  })

  it('will not accept a request token where a confirm token is required', () => {
    // The CSRF defence: only the consent page mints confirm tokens, and only a
    // confirm token carries the uid the POST checks against the live session.
    const req = signAuthzToken(base, REQ_TYP)
    expect(verifyAuthzToken(req, CONFIRM_TYP)).toBeNull()
  })

  it('carries uid on a confirm token so the POST can bind it to the session', () => {
    const confirm = signAuthzToken({ ...base, uid: 'user-9' }, CONFIRM_TYP)
    expect(verifyAuthzToken(confirm, CONFIRM_TYP)?.uid).toBe('user-9')
  })

  it('refuses an MCP access token presented as an authorization token', () => {
    const access = mintAccessToken({
      apiKeyId: 'k',
      projectId: 'p',
      clientId: 'c',
      scope: 'mcp:read',
    }).token
    expect(verifyAuthzToken(access, REQ_TYP)).toBeNull()
    expect(verifyAuthzToken(access, CONFIRM_TYP)).toBeNull()
  })
})

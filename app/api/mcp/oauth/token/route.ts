export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * OAuth token endpoint — `authorization_code` and `refresh_token` grants.
 *
 * ── Single-use codes are enforced by the database, not by a read ────────────
 *
 * Redemption marks the code consumed with a conditional `updateMany` on
 * `consumedAt: null`, and treats "0 rows updated" as the failure. A
 * read-then-write would let two simultaneous redemptions of one code both pass
 * the check and both mint tokens — the classic authorization-code replay, and
 * exactly the race a busy MCP host retrying a request can produce by accident.
 *
 * ── Refresh reuse revokes the chain ─────────────────────────────────────────
 *
 * Refresh tokens rotate on every use (OAuth 2.1 for public clients). Presenting
 * one that was already rotated means the token leaked — the legitimate client
 * would be holding its replacement. So reuse does not merely fail: it revokes
 * every refresh token for that connection, which turns a silent compromise into
 * a visible re-login.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import {
  hashToken,
  mintAccessToken,
  oauthError,
  randomToken,
  REFRESH_TOKEN_TTL_MS,
  verifyPkce,
} from '@/lib/mcp/oauth'

const HEADERS = {
  'cache-control': 'no-store',
  pragma: 'no-cache',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,mcp-protocol-version',
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: HEADERS })
}

function tokenResponse(input: {
  accessToken: string
  expiresIn: number
  refreshToken: string
  scope: string
}) {
  return NextResponse.json(
    {
      access_token: input.accessToken,
      token_type: 'Bearer',
      expires_in: input.expiresIn,
      refresh_token: input.refreshToken,
      scope: input.scope,
    },
    { headers: HEADERS },
  )
}

/** Issue a fresh refresh token for a connection. Returns the plaintext. */
async function issueRefresh(apiKeyId: string, clientId: string): Promise<string> {
  const raw = randomToken(32)
  await prisma.mcpOAuthRefresh.create({
    data: {
      tokenHash: hashToken(raw),
      clientId,
      apiKeyId,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    },
  })
  return raw
}

export async function POST(request: NextRequest) {
  let form: URLSearchParams
  try {
    const raw = await request.text()
    form = new URLSearchParams(raw)
  } catch {
    return oauthError('invalid_request', 'Body must be application/x-www-form-urlencoded.')
  }

  const grantType = form.get('grant_type')
  if (grantType === 'authorization_code') return handleCode(form)
  if (grantType === 'refresh_token') return handleRefresh(form)
  return oauthError('unsupported_grant_type', `Unsupported grant_type "${grantType ?? ''}".`)
}

async function handleCode(form: URLSearchParams) {
  const code = form.get('code')
  const clientId = form.get('client_id')
  const redirectUri = form.get('redirect_uri')
  const codeVerifier = form.get('code_verifier')

  if (!code || !clientId || !redirectUri || !codeVerifier) {
    return oauthError(
      'invalid_request',
      'code, client_id, redirect_uri and code_verifier are all required.',
    )
  }

  const record = await prisma.mcpOAuthCode.findUnique({ where: { codeHash: hashToken(code) } })
  if (!record) return oauthError('invalid_grant', 'Unknown or already-redeemed code.')

  // Bind the code to the client and redirect URI it was issued for. Without
  // both checks a code intercepted from one client could be redeemed by another.
  if (record.clientId !== clientId) {
    return oauthError('invalid_grant', 'This code was not issued to this client.')
  }
  if (record.redirectUri !== redirectUri) {
    return oauthError('invalid_grant', 'redirect_uri does not match the authorization request.')
  }
  if (record.consumedAt) {
    return oauthError('invalid_grant', 'This code was already redeemed.')
  }
  if (record.expiresAt < new Date()) {
    return oauthError('invalid_grant', 'This code expired. Start the authorization again.')
  }
  if (!verifyPkce(codeVerifier, record.codeChallenge)) {
    return oauthError('invalid_grant', 'PKCE verification failed.')
  }

  // Atomic single-use claim. Losing this race means someone else redeemed first.
  const claimed = await prisma.mcpOAuthCode.updateMany({
    where: { id: record.id, consumedAt: null },
    data: { consumedAt: new Date() },
  })
  if (claimed.count !== 1) {
    return oauthError('invalid_grant', 'This code was already redeemed.')
  }

  const connection = await prisma.apiKey.findUnique({
    where: { id: record.apiKeyId },
    select: { id: true, projectId: true },
  })
  if (!connection?.projectId) {
    return oauthError('invalid_grant', 'The connection for this code no longer exists.', 400)
  }

  const { token, expiresIn } = mintAccessToken({
    apiKeyId: connection.id,
    projectId: connection.projectId,
    clientId,
    scope: record.scope,
  })
  const refresh = await issueRefresh(connection.id, clientId)

  await prisma.mcpOAuthClient
    .update({ where: { clientId }, data: { lastUsedAt: new Date() } })
    .catch(() => {})

  return tokenResponse({ accessToken: token, expiresIn, refreshToken: refresh, scope: record.scope })
}

async function handleRefresh(form: URLSearchParams) {
  const presented = form.get('refresh_token')
  const clientId = form.get('client_id')
  if (!presented || !clientId) {
    return oauthError('invalid_request', 'refresh_token and client_id are required.')
  }

  const record = await prisma.mcpOAuthRefresh.findUnique({
    where: { tokenHash: hashToken(presented) },
  })
  if (!record) return oauthError('invalid_grant', 'Unknown refresh token.')
  if (record.clientId !== clientId) {
    return oauthError('invalid_grant', 'This refresh token was not issued to this client.')
  }

  // Reuse of an already-rotated token means it leaked. Burn the whole chain.
  if (record.rotatedToId || record.revokedAt) {
    await prisma.mcpOAuthRefresh.updateMany({
      where: { apiKeyId: record.apiKeyId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    return oauthError(
      'invalid_grant',
      'This refresh token was already used. All tokens for this connection have been revoked; re-authorize the MCP host.',
    )
  }

  if (record.expiresAt < new Date()) {
    return oauthError('invalid_grant', 'This refresh token expired. Re-authorize the MCP host.')
  }

  const connection = await prisma.apiKey.findUnique({
    where: { id: record.apiKeyId },
    select: { id: true, projectId: true, mcpReadOnly: true },
  })
  if (!connection?.projectId) {
    // The human revoked the connection. That must end the token chain.
    return oauthError('invalid_grant', 'This connection was revoked.')
  }

  const scope = await prisma.mcpOAuthCode
    .findFirst({
      where: { apiKeyId: connection.id },
      orderBy: { createdAt: 'desc' },
      select: { scope: true },
    })
    .then((r) => r?.scope ?? 'mcp:read')

  const nextRaw = randomToken(32)
  const next = await prisma.mcpOAuthRefresh.create({
    data: {
      tokenHash: hashToken(nextRaw),
      clientId,
      apiKeyId: connection.id,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    },
  })
  await prisma.mcpOAuthRefresh.update({
    where: { id: record.id },
    data: { rotatedToId: next.id, revokedAt: new Date() },
  })

  const { token, expiresIn } = mintAccessToken({
    apiKeyId: connection.id,
    projectId: connection.projectId,
    clientId,
    scope,
  })

  return tokenResponse({ accessToken: token, expiresIn, refreshToken: nextRaw, scope })
}

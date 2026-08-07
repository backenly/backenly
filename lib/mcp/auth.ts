/**
 * MCP Auth — validates incoming `x-api-key` headers on /api/mcp/* surfaces.
 *
 * Why this is a separate layer (not just `extractProjectIdFromAuth`):
 *
 *   • MCP keys carry broader power — they can drive the brain, create tables,
 *     drop tables. The blast radius is the same as the dashboard. Runtime SDK
 *     keys, by contrast, are designed to live in browser JS. We split them at
 *     the auth layer so a leaked SDK key cannot be replayed into the MCP
 *     surface to wipe a project.
 *
 *   • Authoriation is by the `scope` column on `ApiKey`. `scope='mcp'` is the
 *     only acceptable value here. `scope='runtime'` is explicitly refused with
 *     a distinct error code so the caller can tell the user to mint an MCP
 *     key instead of trying to reuse their SDK key.
 *
 *   • lastUsed is updated fire-and-forget so we get fresh "active client" info
 *     in the dashboard without making every request wait on a write.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey, timingSafeCompare } from '@/lib/auth/apiKeyAuth'
import { protectedResourceMetadataUrl, scopeAllowsWrite, verifyAccessToken } from '@/lib/mcp/oauth'

export interface McpAuthResult {
  success: boolean
  projectId?: string
  userId?: string
  keyId?: string
  scope?: string
  /** Key was issued read-only: every mutating surface must refuse it. */
  readOnly?: boolean
  error?: string
  code?: string
  status?: number
}

/**
 * Validate an `x-api-key` header on an MCP endpoint.
 *
 *   - 401 NO_AUTH         — header missing
 *   - 401 INVALID_KEY     — key not found / expired
 *   - 403 WRONG_SCOPE     — scope is "runtime", not "mcp". User pasted their
 *                           SDK key into the MCP server.
 *   - 200                 — projectId, userId, keyId returned
 */
export async function authenticateMcp(request: NextRequest): Promise<McpAuthResult> {
  // OAuth first. A host that completed the browser flow sends a Bearer token
  // and has no x-api-key at all.
  const authHeader = request.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    return authenticateBearer(authHeader.slice(7).trim())
  }

  const rawKey = request.headers.get('x-api-key')
  if (!rawKey || rawKey.length < 16) {
    return {
      success: false,
      status: 401,
      code: 'NO_AUTH',
      error:
        'No credential. Either sign in through OAuth (your MCP host will prompt you) ' +
        'or send an x-api-key header — run `npx @backenly/mcp-server init` to set one up.',
    }
  }

  const keyHash = hashApiKey(rawKey)

  const record = await prisma.apiKey.findFirst({
    where: { keyHash },
    select: {
      id: true,
      keyHash: true,
      projectId: true,
      userId: true,
      scope: true,
      mcpReadOnly: true,
      expiresAt: true,
    },
  })

  if (!record) {
    return {
      success: false,
      status: 401,
      code: 'INVALID_KEY',
      error:
        'This MCP key is not recognised. It may have been revoked from the dashboard. ' +
        'Generate a new MCP key from Backenly → Project → MCP and re-run `init`.',
    }
  }

  if (!timingSafeCompare(record.keyHash, keyHash)) {
    return { success: false, status: 401, code: 'INVALID_KEY', error: 'Invalid MCP key.' }
  }

  if (record.expiresAt && record.expiresAt < new Date()) {
    return {
      success: false,
      status: 401,
      code: 'KEY_EXPIRED',
      error: 'This MCP key has expired. Generate a new one from the dashboard.',
    }
  }

  if (!record.projectId) {
    return {
      success: false,
      status: 400,
      code: 'NO_PROJECT',
      error: 'This MCP key is not bound to a project.',
    }
  }

  if (record.scope !== 'mcp') {
    return {
      success: false,
      status: 403,
      code: 'WRONG_SCOPE',
      error:
        'This key has scope="runtime" — that is an SDK key for browser clients, not an MCP key. ' +
        'Generate an MCP key from Backenly → Project → MCP and use that one.',
    }
  }

  prisma.apiKey
    .update({ where: { id: record.id }, data: { lastUsed: new Date() } })
    .catch(() => {})

  return {
    success: true,
    projectId: record.projectId,
    userId: record.userId,
    keyId: record.id,
    scope: record.scope,
    readOnly: record.mcpReadOnly,
  }
}

/**
 * Validate an OAuth access token.
 *
 * The token names its connection in `sub` — an ApiKey row created at consent
 * time. Loading it here rather than trusting the token's own claims is what
 * makes revocation instant: deleting the row kills every outstanding token
 * without a blocklist, because there is nothing left to point at.
 *
 * Scope narrows but never widens. A token granted only `mcp:read` is treated as
 * read-only even if the underlying row is read-write, so a future bug that
 * mints an over-broad token still cannot mutate.
 */
async function authenticateBearer(token: string): Promise<McpAuthResult> {
  const claims = verifyAccessToken(token)
  if (!claims) {
    return {
      success: false,
      status: 401,
      code: 'INVALID_TOKEN',
      error:
        'This OAuth access token is invalid or expired. Refresh it, or re-authorize the MCP host.',
    }
  }

  const record = await prisma.apiKey.findUnique({
    where: { id: claims.sub },
    select: { id: true, projectId: true, userId: true, scope: true, mcpReadOnly: true, expiresAt: true },
  })

  // The connection was revoked from the dashboard, so the token names nothing.
  if (!record || !record.projectId) {
    return {
      success: false,
      status: 401,
      code: 'CONNECTION_REVOKED',
      error: 'This connection was revoked. Re-authorize the MCP host to reconnect.',
    }
  }
  if (record.expiresAt && record.expiresAt < new Date()) {
    return { success: false, status: 401, code: 'KEY_EXPIRED', error: 'This connection expired.' }
  }
  if (record.scope !== 'mcp') {
    return { success: false, status: 403, code: 'WRONG_SCOPE', error: 'Not an MCP connection.' }
  }

  prisma.apiKey.update({ where: { id: record.id }, data: { lastUsed: new Date() } }).catch(() => {})

  return {
    success: true,
    projectId: record.projectId,
    userId: record.userId,
    keyId: record.id,
    scope: record.scope,
    readOnly: record.mcpReadOnly || !scopeAllowsWrite(claims.scope),
  }
}

/**
 * Helper: short-circuit handler when auth fails. Returns the matching NextResponse,
 * or null when the caller may proceed. Stamps the standard MCP error envelope.
 */
export function mcpAuthFailureResponse(result: McpAuthResult): NextResponse | null {
  if (result.success) return null
  const status = result.status ?? 401
  return NextResponse.json(
    {
      ok: false,
      error: result.error,
      code: result.code,
    },
    { status, headers: status === 401 ? { 'www-authenticate': wwwAuthenticate(result) } : undefined },
  )
}

/**
 * The RFC 9728 challenge that turns a 401 into a browser login.
 *
 * An MCP host reads `resource_metadata`, fetches the protected-resource
 * document, finds the authorization server, registers itself and opens a
 * browser. Without this header none of that can start — which is precisely why
 * pasting an API key by hand was the only install path we had.
 */
export function wwwAuthenticate(result?: McpAuthResult): string {
  const parts = [`Bearer realm="backenly"`, `resource_metadata="${protectedResourceMetadataUrl()}"`]
  if (result?.code === 'INVALID_TOKEN') {
    parts.splice(1, 0, `error="invalid_token"`, `error_description="The access token is invalid or expired"`)
  }
  return parts.join(', ')
}

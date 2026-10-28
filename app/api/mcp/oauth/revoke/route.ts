export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * RFC 7009 token revocation.
 *
 * Always answers 200, including for a token that does not exist. That is the
 * RFC's requirement and it is also the right behaviour: a revocation endpoint
 * that distinguished "revoked" from "unknown" would be an oracle for testing
 * whether a captured string is a live token.
 *
 * Revoking a refresh token kills the whole connection, not just that token.
 * The alternative — invalidating one token while the ApiKey row stays usable by
 * any outstanding access token — would make "disconnect" a lie for up to the
 * access-token lifetime.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { hashToken, verifyAccessToken } from '@/lib/mcp/oauth'
import { governedChange, withChangeAttribution } from '@/lib/changes/ledger'

const HEADERS = {
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,mcp-protocol-version',
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: HEADERS })
}

/**
 * Delete the connection row; cascades take its codes and refresh tokens. The
 * agent ended its own connection, so the project's history says it did.
 */
async function revokeConnection(apiKeyId: string) {
  const row = await prisma.apiKey.findUnique({ where: { id: apiKeyId }, select: { projectId: true, name: true, userId: true } })
  if (!row) return
  await withChangeAttribution({ source: 'mcp', apiKeyId, actorUserId: row.userId }, () =>
    governedChange(row.projectId, `Disconnect agent ${row.name}`, () => prisma.apiKey.delete({ where: { id: apiKeyId } })),
  ).catch(() => {})
}

export async function POST(request: NextRequest) {
  const ok = new NextResponse(null, { status: 200, headers: HEADERS })

  let form: URLSearchParams
  try {
    form = new URLSearchParams(await request.text())
  } catch {
    return ok
  }

  const token = form.get('token')
  if (!token) return ok

  const hint = form.get('token_type_hint')

  // Refresh token first — it is the common case and the cheap lookup.
  if (hint !== 'access_token') {
    const refresh = await prisma.mcpOAuthRefresh.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { apiKeyId: true },
    })
    if (refresh) {
      await revokeConnection(refresh.apiKeyId)
      return ok
    }
  }

  // Otherwise it may be an access token, which names its connection in `sub`.
  const claims = verifyAccessToken(token)
  if (claims?.sub) await revokeConnection(claims.sub)

  return ok
}

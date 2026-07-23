export const dynamic = 'force-dynamic'

/**
 * DELETE /api/projects/[id]/mcp/keys/[keyId]
 *
 * Revoke an MCP key. Every MCP host using it stops working immediately.
 * Audit-logged for the owner.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { prisma } from '@/lib/db/prisma'

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; keyId: string } },
) {
  return withProjectValidation<any>(req, async ({ projectId, userId }) => {
    const keyId = params.keyId
    if (!keyId) {
      return NextResponse.json({ error: 'keyId required' }, { status: 400 })
    }

    // Only delete if the key belongs to this project AND is an MCP key —
    // we never want this route to be a back-door for revoking an SDK key.
    const key = await prisma.apiKey.findFirst({
      where: { id: keyId, projectId, scope: 'mcp' },
      select: { id: true, name: true, mcpClientLabel: true },
    })
    if (!key) {
      return NextResponse.json({ error: 'MCP key not found' }, { status: 404 })
    }

    await prisma.apiKey.delete({ where: { id: keyId } })

    await prisma.auditLog.create({
      data: {
        projectId,
        userId,
        action: 'MCP_KEY_REVOKED',
        type: 'security',
        details: JSON.stringify({
          keyId,
          label: key.mcpClientLabel,
          name: key.name,
          at: new Date().toISOString(),
        }),
        timestamp: new Date(),
      },
    }).catch(() => {})

    return NextResponse.json({ ok: true, revoked: keyId })
  })
}

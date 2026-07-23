export const dynamic = 'force-dynamic'

/**
 * Shareable change-report links — the owner side.
 *
 * POST   /api/projects/[id]/share-report        → create; returns the raw URL ONCE
 * GET    /api/projects/[id]/share-report        → list active/revoked links (no raw tokens)
 * DELETE /api/projects/[id]/share-report?tokenId=<id>  → revoke
 *
 * Auth: platform JWT + project ownership. The public page (/report/[token])
 * needs no auth — that is the point — but is read-only, revocable, and only
 * renders the non-technical activity ledger + counts.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { prisma } from '@/lib/db/prisma'
import { hashShareToken, newShareToken } from '@/lib/reports/change-report'

export const POST = withProjectAccess(async (req: NextRequest, { user, projectId }) => {
  const raw = newShareToken()
  await prisma.shareToken.create({
    data: {
      projectId,
      kind: 'change_report',
      tokenHash: hashShareToken(raw),
      createdBy: user.userId,
    },
  })
  const origin = req.nextUrl.origin
  return NextResponse.json({
    success: true,
    url: `${origin}/report/${raw}`,
    note: 'Save this link — it is shown once. Revoke it anytime from the same place you created it.',
  })
})

export const GET = withProjectAccess(async (_req: NextRequest, { projectId }) => {
  const rows = await prisma.shareToken.findMany({
    where: { projectId, kind: 'change_report' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, createdAt: true, revokedAt: true, lastViewedAt: true },
  })
  return NextResponse.json({ success: true, links: rows })
})

export const DELETE = withProjectAccess(async (req: NextRequest, { projectId }) => {
  const tokenId = req.nextUrl.searchParams.get('tokenId')
  if (!tokenId) {
    return NextResponse.json({ success: false, error: 'tokenId is required' }, { status: 400 })
  }
  const res = await prisma.shareToken.updateMany({
    where: { id: tokenId, projectId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  if (res.count === 0) {
    return NextResponse.json({ success: false, error: 'Link not found or already revoked' }, { status: 404 })
  }
  return NextResponse.json({ success: true })
})

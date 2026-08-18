/**
 * POST /api/learning/patterns/:id/review
 *
 * Approve or reject a CorrectionPattern after human review.
 *
 * Body:
 *   action    "approve" | "reject" | "archive"
 *   ruleHint  string (required when action = "approve")
 *             Short planning hint injected at plan-generation time.
 *             Written by the reviewer — never auto-generated.
 *   reviewNote  string (optional) — reviewer comment stored for audit
 *
 * Access: platform-authenticated users only (operator use).
 */

import { type NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth/middleware'
import { prisma } from '@/lib/db/prisma'

export const dynamic = 'force-dynamic'

const STATUS_MAP: Record<string, string> = {
  approve: 'APPROVED',
  reject:  'REJECTED',
  archive: 'ARCHIVED',
}

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const auth = await authenticateRequest(request)
  if (!auth.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const pattern = await prisma.correctionPattern.findUnique({
    where: { id: params.id },
  })
  if (!pattern) {
    return NextResponse.json({ error: 'Pattern not found' }, { status: 404 })
  }

  let body: { action?: string; ruleHint?: string; reviewNote?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { action, ruleHint, reviewNote } = body

  if (!action || !STATUS_MAP[action]) {
    return NextResponse.json(
      { error: 'action must be one of: approve, reject, archive' },
      { status: 400 },
    )
  }

  if (action === 'approve') {
    if (!ruleHint || ruleHint.trim().length === 0) {
      return NextResponse.json(
        { error: 'ruleHint is required when approving a pattern' },
        { status: 400 },
      )
    }
    if (ruleHint.length > 500) {
      return NextResponse.json(
        { error: 'ruleHint must be ≤ 500 characters' },
        { status: 400 },
      )
    }
  }

  const updated = await prisma.correctionPattern.update({
    where: { id: params.id },
    data: {
      status:     STATUS_MAP[action],
      reviewedBy: auth.userId ?? null,
      reviewedAt: new Date(),
      reviewNote: reviewNote?.trim() ?? null,
      // Only write ruleHint on approve; clear it on reject/archive
      ruleHint:   action === 'approve' ? ruleHint!.trim() : null,
    },
  })

  return NextResponse.json({ pattern: updated })
}

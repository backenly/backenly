/**
 * GET  /api/learning/patterns  — list CorrectionPatterns (filterable by status)
 * POST /api/learning/patterns  — trigger pattern mining from CorrectionEvents
 *
 * Access: platform-authenticated users only (operator use).
 */

import { type NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth/middleware'
import { minePatterns, getPatternStatusCounts } from '@/lib/ai/pattern-miner'
import { prisma } from '@/lib/db/prisma'

export const dynamic = 'force-dynamic'

// ── GET /api/learning/patterns ────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request)
  if (!auth.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status') ?? 'PENDING_REVIEW'
  const page   = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))
  const limit  = Math.min(50, parseInt(searchParams.get('limit') ?? '20', 10))

  const [patterns, total, statusCounts] = await Promise.all([
    prisma.correctionPattern.findMany({
      where:   { status },
      orderBy: { updatedAt: 'desc' },
      skip:    (page - 1) * limit,
      take:    limit,
    }),
    prisma.correctionPattern.count({ where: { status } }),
    getPatternStatusCounts(),
  ])

  return NextResponse.json({
    patterns,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    statusCounts,
  })
}

// ── POST /api/learning/patterns ───────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request)
  if (!auth.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const result = await minePatterns()

  return NextResponse.json({
    message: 'Pattern mining complete.',
    result,
  })
}

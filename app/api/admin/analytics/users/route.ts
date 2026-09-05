export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/admin/auth/requireFounder'
import { prisma } from '@/lib/db/prisma'

/**
 * GET /api/admin/analytics/users
 *
 * Returns a list of all platform users with usage summary.
 * FOUNDER-ONLY.
 */
export async function GET(request: NextRequest) {
  const authError = await requireFounder(request)
  if (authError) return authError

  const users = await prisma.user.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      email: true,
      createdAt: true,
      lastLogin: true,
      lastActiveAt: true,
      tier: true,
      emailVerified: true,
      trustLevel: true,
      signupScore: true,
      signupSignals: true,
      _count: {
        select: { projects: true },
      },
    },
  })

  // Fetch usage totals per user
  const usageTotals = await prisma.usageMetric.groupBy({
    by: ['userId'],
    _sum: {
      apiCalls: true,
      dbReads: true,
      dbWrites: true,
      aiCalls: true,
    },
  })

  const usageMap = new Map(usageTotals.map((u) => [u.userId, u._sum]))

  const result = users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    createdAt: u.createdAt,
    lastActive: u.lastActiveAt ?? u.lastLogin,
    tier: u.tier,
    projectCount: u._count.projects,
    // Signup provenance, so the Users tab can separate customers from noise
    // instead of showing one undifferentiated list.
    emailVerified: u.emailVerified,
    trustLevel: u.trustLevel,
    signupScore: u.signupScore,
    signupSignals: u.signupSignals,
    usage: usageMap.get(u.id) ?? {
      apiCalls: 0,
      dbReads: 0,
      dbWrites: 0,
      aiCalls: 0,
    },
  }))

  return NextResponse.json({ users: result })
}

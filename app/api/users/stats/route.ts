export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { requireAuth } from '@/lib/auth/middleware'

export async function GET(request: NextRequest) {
  try {
    await requireAuth(request)
    
    const [
      totalUsers,
      activeUsers,
      verifiedUsers,
      signups24h,
      signups7d,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({
        where: {
          lastLogin: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
          },
        },
      }),
      prisma.user.count({
        where: { emailVerified: true },
      }),
      prisma.user.count({
        where: {
          createdAt: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
          },
        },
      }),
      prisma.user.count({
        where: {
          createdAt: {
            gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
          },
        },
      }),
    ])
    
    // Calculate delta (simplified - in production, compare with previous period)
    const previousActiveUsers = await prisma.user.count({
      where: {
        lastLogin: {
          gte: new Date(Date.now() - 48 * 60 * 60 * 1000),
          lt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        },
      },
    })
    const activeUsersDelta = activeUsers - previousActiveUsers
    
    const previousSignups = await prisma.user.count({
      where: {
        createdAt: {
          gte: new Date(Date.now() - 48 * 60 * 60 * 1000),
          lt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        },
      },
    })
    const signupsDelta = signups24h - previousSignups
    
    return NextResponse.json({
      totalUsers,
      activeUsers,
      activeUsersDelta,
      verifications: verifiedUsers,
      signups24h,
      signupsDelta,
      signups7d,
    })
  } catch (error) {
    console.error('Get user stats error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch user stats' },
      { status: 500 }
    )
  }
}


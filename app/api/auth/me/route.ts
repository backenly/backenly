export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/route-protection';
import { prisma } from '@/lib/db/postgres';

/**
 * GET /api/auth/me - Get current user profile
 * 
 * Returns authenticated user details including projects
 */
export const GET = withAuth(async (request: NextRequest, { user }) => {
  try {
    // Get user details with projects
    const userDetails = await prisma.user.findUnique({
      where: { id: user.userId },
      select: {
        id: true,
        email: true,
        name: true,
        provider: true,
        emailVerified: true,
        // Drives the verification wall in the app shell. Only accounts flagged
        // untrusted at signup are walled, so the 21 pre-existing unverified
        // accounts (all trusted) are untouched.
        trustLevel: true,
        twoFactorEnabled: true,
        createdAt: true,
        lastLogin: true,
        tier: true,
        projects: {
          select: {
            id: true,
            name: true,
            slug: true,
            createdAt: true,
          },
          orderBy: {
            createdAt: 'desc',
          },
        },
      },
    });

    if (!userDetails) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    const profile = {
      id: userDetails.id,
      email: userDetails.email,
      name: userDetails.name,
      provider: userDetails.provider,
      emailVerified: userDetails.emailVerified,
      trustLevel: userDetails.trustLevel,
      twoFactorEnabled: userDetails.twoFactorEnabled,
      createdAt: userDetails.createdAt,
      lastLogin: userDetails.lastLogin,
      tier: userDetails.tier,
      projectsCount: userDetails.projects.length,
    }

    return NextResponse.json({
      ...profile,
      projects: userDetails.projects,
      user: profile,
    });
  } catch (error) {
    console.error('Auth me error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch user profile' },
      { status: 500 }
    );
  }
});

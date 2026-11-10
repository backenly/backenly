export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/route-protection';
import { platformProfile } from '@/lib/auth/platform-profile';

/**
 * GET /api/auth/me - Get current user profile
 * 
 * Returns authenticated user details including projects
 */
export const GET = withAuth(async (request: NextRequest, { user }) => {
  try {
    const found = await platformProfile(user.userId)
    if (!found) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }
    const { profile } = found

    return NextResponse.json({
      ...profile,
      projects: found.projects,
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

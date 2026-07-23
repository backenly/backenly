export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server';
import { verifySession } from '@/lib/auth/session';
import { cookies } from 'next/headers';
import { getWorkspaceUsers } from '@/lib/services/workspaceAuth';

/**
 * GET /api/workspace-users?projectId=xxx - Get all users from workspace database
 */
export async function GET(request: NextRequest) {
  try {
    // Verify session
    const cookieStore = await cookies();
    const sessionToken = cookieStore.get('session')?.value;
    
    if (!sessionToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const session = await verifySession(sessionToken);
    if (!session.valid) {
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
    }

    // Get projectId from query params
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId');

    if (!projectId) {
      return NextResponse.json(
        { error: 'projectId is required' },
        { status: 400 }
      );
    }

    // Get users
    const users = await getWorkspaceUsers(projectId);

    return NextResponse.json({ users });
  } catch (error: any) {
    console.error('Get workspace users error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch users' },
      { status: 500 }
    );
  }
}

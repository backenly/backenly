export const dynamic = 'force-dynamic'

/**
 * Workspace OAuth Configuration API - Single Provider
 * 
 * DELETE /api/workspace-oauth/[provider] - Delete OAuth config
 */

import { NextRequest, NextResponse } from 'next/server'
import { WorkspaceOAuthService } from '@/lib/services/workspaceOAuth'
import { requireAuth } from '@/lib/auth/middleware'

export async function DELETE(
  request: NextRequest,
  { params }: { params: { provider: string } }
) {
  try {
    const auth = await requireAuth(request)
    if (!auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Get project ID from header (tenant isolation)
    const projectId = request.headers.get('x-project-id')
    if (!projectId) {
      return NextResponse.json({ error: 'Project ID required' }, { status: 400 })
    }

    // TODO: Verify user has access to this project

    const provider = params.provider

    await WorkspaceOAuthService.deleteConfig(projectId, provider)

    return NextResponse.json({
      success: true,
      message: `${provider} OAuth configuration deleted`,
    })
  } catch (error: any) {
    console.error('[Workspace OAuth API] Error deleting config:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to delete OAuth config' },
      { status: 500 }
    )
  }
}

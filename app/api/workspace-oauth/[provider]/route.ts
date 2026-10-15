export const dynamic = 'force-dynamic'

/**
 * Workspace OAuth Configuration API - Single Provider
 *
 * DELETE /api/workspace-oauth/[provider] - Delete OAuth config
 *
 * Removing a provider takes that sign-in method away from the project's end
 * users and discards the stored client secret, which the dashboard cannot undo.
 * So it is held at ADMIN, one rank above saving one. The project comes from the
 * `x-project-id` header and is resolved for the caller, never trusted as sent.
 */

import { NextRequest, NextResponse } from 'next/server'
import { WorkspaceOAuthService } from '@/lib/services/workspaceOAuth'
import { requireProjectCapability, TenantIsolationError } from '@/lib/tenant/isolation'
import { canAdministerProject } from '@/lib/edition/guard'

export async function DELETE(request: NextRequest, props: { params: Promise<{ provider: string }> }) {
  const params = await props.params;
  try {
    const { projectId } = await requireProjectCapability(request, canAdministerProject)

    const provider = params.provider

    await WorkspaceOAuthService.deleteConfig(projectId, provider)

    return NextResponse.json({
      success: true,
      message: `${provider} OAuth configuration deleted`,
    })
  } catch (error: any) {
    if (error instanceof TenantIsolationError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    console.error('[Workspace OAuth API] Error deleting config:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to delete OAuth config' },
      { status: 500 }
    )
  }
}

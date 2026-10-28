export const dynamic = 'force-dynamic'

/**
 * Workspace OAuth Configuration API
 *
 * GET /api/workspace-oauth - List all OAuth configs for workspace
 * POST /api/workspace-oauth - Create/update OAuth config
 *
 * These rows hold the OAuth client a project's END USERS sign in through, so
 * writing one decides which OAuth app "Sign in with Google" authorizes against.
 * The project comes from the `x-project-id` header, which is a request, never a
 * grant: requireProjectCapability resolves it for the caller and the guard
 * decides the role. Reading is VIEWER (no secret is ever returned); saving is
 * DEVELOPER, as with the rest of the auth configuration.
 */

import { NextRequest, NextResponse } from 'next/server'
import { WorkspaceOAuthService } from '@/lib/services/workspaceOAuth'
import { requireProjectCapability, TenantIsolationError } from '@/lib/tenant/isolation'
import { canAccessProject, canWriteProject } from '@/lib/edition/guard'

function refusal(error: unknown): NextResponse | null {
  if (!(error instanceof TenantIsolationError)) return null
  return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
}

export async function GET(request: NextRequest) {
  try {
    const { projectId } = await requireProjectCapability(request, canAccessProject)

    const configs = await WorkspaceOAuthService.listConfigs(projectId)

    return NextResponse.json({
      success: true,
      configs,
    })
  } catch (error: any) {
    const refused = refusal(error)
    if (refused) return refused
    console.error('[Workspace OAuth API] Error listing configs:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to list OAuth configs' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const { projectId } = await requireProjectCapability(request, canWriteProject)

    const body = await request.json()
    const { provider, clientId, clientSecret, redirectUri, scopes, enabled } = body

    if (!provider || !clientId || !clientSecret) {
      return NextResponse.json(
        { error: 'Provider, clientId, and clientSecret are required' },
        { status: 400 }
      )
    }

    const config = await WorkspaceOAuthService.upsertConfig(projectId, {
      provider,
      clientId,
      clientSecret,
      redirectUri,
      scopes: scopes || [],
      enabled: enabled ?? true,
    })

    return NextResponse.json({
      success: true,
      config: {
        ...config,
        clientSecret: '***REDACTED***', // Don't send secret back
      },
      message: 'OAuth configuration saved successfully',
    })
  } catch (error: any) {
    const refused = refusal(error)
    if (refused) return refused
    console.error('[Workspace OAuth API] Error saving config:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to save OAuth config' },
      { status: 500 }
    )
  }
}

export const dynamic = 'force-dynamic'

/**
 * Workspace OAuth Configuration API
 * 
 * GET /api/workspace-oauth - List all OAuth configs for workspace
 * POST /api/workspace-oauth - Create/update OAuth config
 */

import { NextRequest, NextResponse } from 'next/server'
import { WorkspaceOAuthService } from '@/lib/services/workspaceOAuth'
import { requireAuth } from '@/lib/auth/middleware'

export async function GET(request: NextRequest) {
  let auth: { userId: string; userEmail: string } | null = null
  try {
    auth = await requireAuth(request)
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!auth?.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // Get project ID from header (tenant isolation)
    const projectId = request.headers.get('x-project-id')
    if (!projectId) {
      return NextResponse.json({ error: 'Project ID required' }, { status: 400 })
    }

    const configs = await WorkspaceOAuthService.listConfigs(projectId)

    return NextResponse.json({
      success: true,
      configs,
    })
  } catch (error: any) {
    console.error('[Workspace OAuth API] Error listing configs:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to list OAuth configs' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  let auth: { userId: string; userEmail: string } | null = null
  try {
    auth = await requireAuth(request)
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!auth?.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // Get project ID from header (tenant isolation)
    const projectId = request.headers.get('x-project-id')
    if (!projectId) {
      return NextResponse.json({ error: 'Project ID required' }, { status: 400 })
    }

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
    console.error('[Workspace OAuth API] Error saving config:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to save OAuth config' },
      { status: 500 }
    )
  }
}

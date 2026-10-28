export const dynamic = 'force-dynamic'

/**
 * Provider Credential by Provider API
 * 
 * GET /api/provider-credentials/[provider] - Get credentials (decrypted)
 * DELETE /api/provider-credentials/[provider] - Delete credentials
 */

import { NextRequest, NextResponse } from 'next/server'
import { ProviderCredentialsService } from '@/lib/services/provider-credentials'
import { requireProjectCapability, TenantIsolationError } from '@/lib/tenant/isolation'
import { canAdministerProject } from '@/lib/edition/guard'

// GET /api/provider-credentials/[provider] — whether credentials are configured.
//
// This used to decrypt the stored deploy-provider token and send it to any
// member who could RESOLVE the project — a VIEWER could read the owner's
// Vercel token in plaintext. Two fixes at once: the floor is ADMIN, and the
// decrypted material no longer leaves the server at all — the deploy
// pipeline reads it through ProviderCredentialsService server-side, and no UI
// ever consumed the value. A configuration screen needs to know a credential
// is SET, not what it is.
export async function GET(request: NextRequest, props: { params: Promise<{ provider: string }> }) {
  const params = await props.params;
  try {
    const { projectId } = await requireProjectCapability(request, canAdministerProject)
    const credentials = await ProviderCredentialsService.getCredentials(
      projectId,
      params.provider as any
    )

    if (!credentials) {
      return NextResponse.json(
        { error: 'Credentials not found' },
        { status: 404 }
      )
    }

    return NextResponse.json({
      success: true,
      provider: params.provider,
      configured: true,
    })
  } catch (error: any) {
    if (error instanceof TenantIsolationError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status ?? 403 }
      )
    }
    console.error('Failed to get credentials:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to get credentials' },
      { status: 500 }
    )
  }
}

// DELETE /api/provider-credentials/[provider] - Delete credentials (ADMIN —
// removing a deploy credential is a credential surface, same floor as reading
// its existence).
export async function DELETE(request: NextRequest, props: { params: Promise<{ provider: string }> }) {
  const params = await props.params;
  try {
    const { projectId } = await requireProjectCapability(request, canAdministerProject)
    await ProviderCredentialsService.deleteCredentials(
      projectId,
      params.provider as any
    )

    return NextResponse.json({
      success: true,
    })
  } catch (error: any) {
    if (error instanceof TenantIsolationError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status ?? 403 }
      )
    }
    console.error('Failed to delete credentials:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to delete credentials' },
      { status: 500 }
    )
  }
}


export const dynamic = 'force-dynamic'

/**
 * Provider Credential by Provider API
 * 
 * GET /api/provider-credentials/[provider] - Get credentials (decrypted)
 * DELETE /api/provider-credentials/[provider] - Delete credentials
 */

import { NextRequest, NextResponse } from 'next/server'
import { ProviderCredentialsService } from '@/lib/services/provider-credentials'
import { withTenantIsolation, TenantIsolationError } from '@/lib/tenant/isolation'

// GET /api/provider-credentials/[provider] - Get credentials
export async function GET(request: NextRequest, props: { params: Promise<{ provider: string }> }) {
  const params = await props.params;
  try {
    return await withTenantIsolation(request, async (projectId) => {
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
        credentials,
      })
    })
  } catch (error: any) {
    if (error instanceof TenantIsolationError) {
      return NextResponse.json(
        { error: error.message },
        { status: 403 }
      )
    }
    console.error('Failed to get credentials:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to get credentials' },
      { status: 500 }
    )
  }
}

// DELETE /api/provider-credentials/[provider] - Delete credentials
export async function DELETE(request: NextRequest, props: { params: Promise<{ provider: string }> }) {
  const params = await props.params;
  try {
    return await withTenantIsolation(request, async (projectId) => {
      await ProviderCredentialsService.deleteCredentials(
        projectId,
        params.provider as any
      )

      return NextResponse.json({
        success: true,
      })
    })
  } catch (error: any) {
    if (error instanceof TenantIsolationError) {
      return NextResponse.json(
        { error: error.message },
        { status: 403 }
      )
    }
    console.error('Failed to delete credentials:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to delete credentials' },
      { status: 500 }
    )
  }
}


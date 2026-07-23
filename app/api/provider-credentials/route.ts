export const dynamic = 'force-dynamic'

/**
 * Provider Credentials API
 * 
 * GET /api/provider-credentials - List credentials
 * POST /api/provider-credentials - Save credentials
 */

import { NextRequest, NextResponse } from 'next/server'
import { ProviderCredentialsService } from '@/lib/services/provider-credentials'
import { withTenantIsolation, TenantIsolationError } from '@/lib/tenant/isolation'

// GET /api/provider-credentials - List credentials
export async function GET(request: NextRequest) {
  try {
    return await withTenantIsolation(request, async (projectId) => {
      const credentials = await ProviderCredentialsService.listCredentials(projectId)

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
    console.error('Failed to list credentials:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to list credentials' },
      { status: 500 }
    )
  }
}

// POST /api/provider-credentials - Save credentials
export async function POST(request: NextRequest) {
  try {
    return await withTenantIsolation(request, async (projectId) => {
      const body = await request.json()
      const { provider, credentials, name } = body

      if (!provider || !credentials) {
        return NextResponse.json(
          { error: 'Provider and credentials are required' },
          { status: 400 }
        )
      }

      const saved = await ProviderCredentialsService.saveCredentials(
        projectId,
        provider,
        credentials,
        name
      )

      return NextResponse.json({
        success: true,
        credential: {
          id: saved.id,
          provider: saved.provider,
          name: saved.name,
          lastUsedAt: saved.lastUsedAt,
          createdAt: saved.createdAt,
          updatedAt: saved.updatedAt,
        },
      })
    })
  } catch (error: any) {
    if (error instanceof TenantIsolationError) {
      return NextResponse.json(
        { error: error.message },
        { status: 403 }
      )
    }
    console.error('Failed to save credentials:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to save credentials' },
      { status: 500 }
    )
  }
}


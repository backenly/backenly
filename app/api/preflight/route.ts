export const dynamic = 'force-dynamic'

/**
 * Preflight API
 * 
 * POST /api/preflight - Run preflight checks before deployment
 */

import { NextRequest, NextResponse } from 'next/server'
import { withTenantIsolation } from '@/lib/tenant/isolation'
import { PreflightService } from '@/lib/services/preflight'

export async function POST(request: NextRequest) {
  try {
    return await withTenantIsolation(request, async (projectId) => {
      const body = await request.json().catch(() => ({}))
      const { timeout } = body

      // Run preflight
      const result = await PreflightService.runPreflight({
        projectId,
        timeout,
      })

      if (result.success) {
        return NextResponse.json({
          success: true,
          result,
        })
      } else {
        return NextResponse.json(
          {
            success: false,
            result,
            error: result.error || 'Preflight check failed',
          },
          { status: 400 }
        )
      }
    })
  } catch (error: any) {
    console.error('Preflight error:', error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Preflight check failed',
      },
      { status: 500 }
    )
  }
}


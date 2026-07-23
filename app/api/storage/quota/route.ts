export const dynamic = 'force-dynamic'

/**
 * GET /api/storage/quota
 *
 * Returns current storage quota usage for the authenticated project (#75).
 *
 * Response:
 *   used        number  — bytes used
 *   limit       number  — bytes allowed
 *   available   number  — bytes remaining
 *   percentUsed number  — 0–100
 *   isExceeded  boolean
 */

import { NextRequest, NextResponse } from 'next/server'
import { withTenantIsolation, TenantIsolationError } from '@/lib/tenant/isolation'
import { getProjectQuota } from '@/lib/services/storageQuota'

export async function GET(request: NextRequest) {
  try {
    return await withTenantIsolation(request, async (projectId) => {
      const quota = await getProjectQuota(projectId)

      return NextResponse.json({
        used: quota.used.toString(),
        limit: quota.limit.toString(),
        available: quota.available.toString(),
        percentUsed: quota.percentUsed,
        isExceeded: quota.isExceeded,
        // Human-readable
        usedMb: Math.round(Number(quota.used) / (1024 * 1024)),
        limitMb: Math.round(Number(quota.limit) / (1024 * 1024)),
      })
    })
  } catch (err) {
    if (err instanceof TenantIsolationError) {
      return NextResponse.json({ error: err.message }, { status: 403 })
    }
    console.error('[Storage/quota]', err)
    return NextResponse.json({ error: 'Failed to fetch quota' }, { status: 500 })
  }
}

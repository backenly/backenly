export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { storageService } from '@/lib/services/storage'
import { withTenantIsolation, TenantIsolationError } from '@/lib/tenant/isolation'

// GET /api/storage/stats - Get storage statistics
export async function GET(request: NextRequest) {
  try {
    return await withTenantIsolation(request, async (projectId) => {
      // projectId is now enforced by tenant isolation middleware
      const stats = await storageService.getProjectStats(projectId)

      // Convert BigInt to Number for JSON serialization
      const serializedStats = {
        ...stats,
        totalSize: Number(stats.totalSize),
        buckets: stats.buckets.map(bucket => ({
          name: bucket.name,
          fileCount: bucket.fileCount,
          totalSize: Number(bucket.size)
        }))
      }

      return NextResponse.json({ stats: serializedStats })
    })
  } catch (error: any) {
    if (error instanceof TenantIsolationError) {
      return NextResponse.json(
        { error: error.message },
        { status: 403 }
      )
    }
    console.error('Failed to get storage stats:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to get storage stats' },
      { status: 500 }
    )
  }
}


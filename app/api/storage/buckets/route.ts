export const dynamic = 'force-dynamic'

/**
 * STORAGE API - BUCKETS
 * 
 * CRITICAL RULES (ENFORCED):
 * ✅ Call StorageService (existing engine)
 * ✅ NO direct S3/disk access
 * ✅ Tenant isolation enforced
 * ✅ Read-only for listing
 */

import { NextRequest, NextResponse } from 'next/server'
import { withTenantIsolation, TenantIsolationError } from '@/lib/tenant/isolation'
import { storageService } from '@/lib/services/storage'

export async function GET(request: NextRequest) {
  try {
    return await withTenantIsolation(request, async (projectId) => {
      console.log('[Storage API] Fetching buckets for project:', projectId)
      
      try {
        // PHASE 3: Call storage provisioning verification service
        // Returns buckets with real-time status (ready/pending/error)
        const { listBucketsWithStatus } = await import('@/lib/services/storage-provisioning-verification')
        const bucketsWithStatus = await listBucketsWithStatus(projectId)
        
        return NextResponse.json({
          success: true,
          buckets: bucketsWithStatus.map(bucket => ({
            id: bucket.id,
            name: bucket.name,
            isPublic: bucket.isPublic,
            fileCount: bucket.fileCount,
            totalSize: bucket.totalSize.toString(), // BigInt to string
            // PHASE 3: Include provisioning status
            status: bucket.status,
            canUpload: bucket.canUpload,
          })),
        })
      } catch (error: any) {
        console.error('[Storage API] Failed to fetch buckets:', error)
        return NextResponse.json(
          { 
            success: false,
            message: error.message || 'Failed to fetch buckets',
          },
          { status: 500 }
        )
      }
    })
  } catch (error: any) {
    if (error instanceof TenantIsolationError) {
      return NextResponse.json(
        { error: error.message },
        { status: 403 }
      )
    }
    return NextResponse.json(
      { error: 'Failed to fetch buckets' },
      { status: 500 }
    )
  }
}

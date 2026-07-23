export const dynamic = 'force-dynamic'

/**
 * STORAGE API - FILES
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
      const { searchParams } = new URL(request.url)
      const bucketId = searchParams.get('bucketId')
      
      console.log('[Storage API] Fetching files for project:', projectId, 'bucket:', bucketId)
      
      try {
        // Call existing storage engine
        const files = await storageService.listFiles(bucketId || undefined, projectId)
        
        return NextResponse.json({
          success: true,
          files: files.map(file => ({
            id: file.id,
            name: file.name,
            size: file.size.toString(), // BigInt to string
            mimeType: file.mimeType,
            isPublic: file.isPublic,
            bucket: file.bucket,
            createdAt: file.createdAt.toISOString(),
            url: file.url,
          })),
        })
      } catch (error: any) {
        console.error('[Storage API] Failed to fetch files:', error)
        return NextResponse.json(
          { 
            success: false,
            message: error.message || 'Failed to fetch files',
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
      { error: 'Failed to fetch files' },
      { status: 500 }
    )
  }
}

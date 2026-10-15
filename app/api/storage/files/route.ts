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
      // The client sends limit/offset/search and this route used to drop
      // them, so every console read was silently the service's first 100
      // rows presented as everything. Parse them, clamp the page size, and
      // return the matching TOTAL so the console can say "N of M".
      const rawLimit = Number(searchParams.get('limit'))
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100
      const rawOffset = Number(searchParams.get('offset'))
      const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0
      const search = searchParams.get('search') || undefined

      console.log('[Storage API] Fetching files for project:', projectId, 'bucket:', bucketId)

      try {
        // Call existing storage engine
        const [files, total] = await Promise.all([
          storageService.listFiles(bucketId || undefined, projectId, { limit, offset, search }),
          storageService.countFiles(bucketId || undefined, projectId, search),
        ])

        return NextResponse.json({
          success: true,
          total,
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

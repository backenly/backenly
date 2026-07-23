export const dynamic = 'force-dynamic'

/**
 * STORAGE API - FILE UPLOAD
 * 
 * CRITICAL RULES (ENFORCED):
 * ✅ Call StorageService (existing engine)
 * ✅ NO direct S3/disk access
 * ✅ Tenant isolation enforced
 * ✅ Requires explicit confirmation (file upload is mutation)
 */

import { NextRequest, NextResponse } from 'next/server'
import { withTenantIsolation, TenantIsolationError } from '@/lib/tenant/isolation'
import { storageService } from '@/lib/services/storage'
import { assertQuotaAvailable, QuotaExceededError } from '@/lib/services/storageQuota'

export async function POST(request: NextRequest) {
  try {
    return await withTenantIsolation(request, async (projectId) => {
      console.log('[Storage API] Uploading file for project:', projectId)

      try {
        const formData = await request.formData()
        const file = formData.get('file') as File
        const bucketId = formData.get('bucketId') as string

        if (!file) {
          return NextResponse.json(
            { success: false, message: 'No file provided' },
            { status: 400 }
          )
        }

        if (!bucketId) {
          return NextResponse.json(
            { success: false, message: 'Bucket ID required' },
            { status: 400 }
          )
        }

        // ── Quota enforcement (#75) ──────────────────────────────────────────
        // Check before reading the file body to fail fast on over-quota projects.
        // file.size is available from the FormData entry without re-reading the body.
        await assertQuotaAvailable(projectId, file.size)

        // Convert File to Buffer
        const arrayBuffer = await file.arrayBuffer()
        const buffer = Buffer.from(arrayBuffer)

        // Call existing storage engine (SAME AS CHAT)
        const uploadedFile = await storageService.uploadFile(
          bucketId,
          {
            name: file.name,
            buffer: buffer,
            mimeType: file.type || undefined,
          },
          {
            projectId,
            isPublic: false, // Default to private
          }
        )

        return NextResponse.json({
          success: true,
          file: {
            id: uploadedFile.id,
            name: uploadedFile.name,
            url: uploadedFile.url,
            size: uploadedFile.size.toString(),
          },
        })
      } catch (error: any) {
        if (error instanceof QuotaExceededError) {
          return NextResponse.json(
            {
              success: false,
              message: error.message,
              code: 'QUOTA_EXCEEDED',
              quota: {
                usedMb: Math.round(Number(error.quota.used) / (1024 * 1024)),
                limitMb: Math.round(Number(error.quota.limit) / (1024 * 1024)),
                percentUsed: error.quota.percentUsed,
              },
            },
            { status: 413 }
          )
        }
        console.error('[Storage API] Failed to upload file:', error)
        return NextResponse.json(
          {
            success: false,
            message: error.message || 'Failed to upload file',
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
      { error: 'Failed to upload file' },
      { status: 500 }
    )
  }
}

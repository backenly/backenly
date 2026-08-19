export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { v1ApiMiddleware, requirePermission } from '@/lib/api/v1/middleware'
import { createErrorResponse, createSuccessResponse, ErrorCodes } from '@/lib/api/v1/errors'
import { prisma } from '@/lib/db'
import { incrementStorageUsed } from '@/lib/services/storageQuota'
import { storageService } from '@/lib/services/storage'

/**
 * POST /v1/{projectId}/storage/confirm-upload
 *
 * Confirms that a direct-to-S3 (pre-signed URL) upload has completed.
 * The client calls this endpoint after PUT-ing the file to S3 so the server can:
 *   1. Mark the StorageFile record status from 'pending' → 'complete'
 *   2. Increment the project's storage quota usage
 *
 * Required because the server is NOT in the S3 upload path — it only issues
 * the pre-signed URL, then the client uploads directly to S3.  Without this
 * step, storage usage tracking would be inaccurate and the file stays 'pending'.
 *
 * Body: { fileId: string }
 *
 * Response: { id, path, url, size, status: 'complete' }
 */
export async function POST(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  try {
    const middleware = await v1ApiMiddleware(request, params)
    if (middleware.response) return middleware.response

    const { context } = middleware

    const permCheck = requirePermission(context, ['write', 'admin'])
    if (permCheck) return permCheck

    let fileId: string | undefined
    try {
      const body = await request.json()
      fileId = typeof body?.fileId === 'string' ? body.fileId.trim() : undefined
    } catch {
      return createErrorResponse(ErrorCodes.BAD_REQUEST, 'Request body must be JSON with a "fileId" field.', 400)
    }

    if (!fileId) {
      return createErrorResponse(ErrorCodes.BAD_REQUEST, '"fileId" is required', 400)
    }

    const fileRecord = await prisma.storageFile.findFirst({
      where: { id: fileId, projectId: context.projectId },
    })

    if (!fileRecord) {
      return createErrorResponse(ErrorCodes.NOT_FOUND, 'File record not found', 404)
    }

    const meta: any = fileRecord.metadata || {}

    // Mint the real, resolvable download URL. `path` now equals the S3 object
    // key, so getFileUrl presigns (or returns the public CDN URL for) the exact
    // object the client just PUT. Falls back to any previously stored url.
    let url: string | null = meta.url ?? null
    try {
      url = await storageService.getFileUrl(fileRecord.id, context.projectId)
    } catch (err: any) {
      console.warn('[ConfirmUpload] Could not generate file URL:', err?.message)
    }

    // If already confirmed, return current state (idempotent)
    if (meta.status === 'complete') {
      return createSuccessResponse({
        id: fileRecord.id,
        path: fileRecord.path,
        url,
        size: Number(fileRecord.size),
        status: 'complete',
      })
    }

    // Mark as complete
    await prisma.storageFile.update({
      where: { id: fileRecord.id },
      data: { metadata: { ...meta, status: 'complete', url } },
    })

    // Increment quota usage (non-blocking)
    if (fileRecord.size) {
      incrementStorageUsed(context.projectId, fileRecord.size).catch(
        (err: any) => console.warn('[Storage] Failed to increment storage usage after confirm-upload:', err?.message)
      )
    }

    return createSuccessResponse({
      id: fileRecord.id,
      path: fileRecord.path,
      url,
      size: Number(fileRecord.size),
      status: 'complete',
    })
  } catch (error: any) {
    console.error('[ConfirmUpload] Error:', error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, 'Failed to confirm upload', 500)
  }
}

export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { v1ApiMiddleware, requirePermission, requireCapability } from '@/lib/api/v1/middleware'
import { createErrorResponse, createSuccessResponse, ErrorCodes } from '@/lib/api/v1/errors'
import { storageService } from '@/lib/services/storage'
import { prisma } from '@/lib/db'
import { processImage, mimeToExtension } from '@/lib/storage/image-processor'
import { assertQuotaAvailable, QuotaExceededError } from '@/lib/services/storageQuota'
import path from 'path'

// ── Global hard limits (defence-in-depth before any bucket config) ─────────
// Default is 500 MB to support video/asset uploads via this endpoint.
// For files larger than 500 MB use /storage/upload-multipart or /storage/signed-upload
// which bypass the server entirely when STORAGE_DRIVER=s3.
const GLOBAL_MAX_FILE_SIZE_BYTES = parseInt(
  process.env.STORAGE_GLOBAL_MAX_FILE_SIZE || String(500 * 1024 * 1024), // 500 MB default
  10
)

// Completely blocked file types regardless of bucket settings
const BLOCKED_MIME_TYPES = new Set([
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-sh',
  'application/x-bat',
  'application/x-csh',
])

const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.sh', '.bash', '.ps1', '.ps2',
  '.app', '.deb', '.rpm', '.msi', '.dmg', '.pkg', '.run',
  '.jar', '.dll', '.so', '.dylib', '.scr', '.vbs',
  '.jse', '.wsf', '.wsh', '.com', '.pif', '.lnk',
])

/**
 * POST /v1/{projectId}/storage/upload
 *
 * Upload a file to a storage bucket.
 * Supports optional image processing via query params:
 *   ?width=800          — resize to max 800px wide (proportional)
 *   ?height=600         — resize to max 600px tall (proportional)
 *   ?format=webp        — convert to webp/jpeg/png
 *   ?quality=85         — lossy quality 1–100 (default 85)
 *
 * Body (multipart/form-data):
 *   file      — the File blob
 *   bucket    — bucket name (default: 'default')
 *   path      — desired file path/name inside the bucket
 *   isPublic  — 'true' | 'false'
 */
export async function POST(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  try {
    const middleware = await v1ApiMiddleware(request, params)
    if (middleware.response) {
      return middleware.response
    }

    const { context } = middleware

    const permissionCheck = requirePermission(context, ['write', 'admin'])
    if (permissionCheck) {
      return permissionCheck
    }

    const capabilityCheck = requireCapability(context, request.nextUrl.pathname)
    if (capabilityCheck) {
      return capabilityCheck
    }

    // ── Parse multipart form data ─────────────────────────────────────────
    const formData = await request.formData()
    const file = formData.get('file') as File | null
    const bucketName = (formData.get('bucket') as string | null) || 'default'
    const filePath = (formData.get('path') as string | null) || ''
    const isPublic = formData.get('isPublic') === 'true'

    if (!file) {
      return createErrorResponse(ErrorCodes.BAD_REQUEST, 'Missing required field: file', 400)
    }
    if (!filePath) {
      return createErrorResponse(ErrorCodes.BAD_REQUEST, 'Missing required field: path', 400)
    }

    // ── Global hard limits (run BEFORE reading full buffer) ───────────────
    const fileExt = path.extname(filePath).toLowerCase()
    const mimeType = file.type || 'application/octet-stream'

    if (BLOCKED_EXTENSIONS.has(fileExt)) {
      return createErrorResponse(
        ErrorCodes.BAD_REQUEST,
        `File extension "${fileExt}" is not allowed for security reasons.`,
        400
      )
    }

    if (BLOCKED_MIME_TYPES.has(mimeType)) {
      return createErrorResponse(
        ErrorCodes.BAD_REQUEST,
        `File type "${mimeType}" is not allowed for security reasons.`,
        400
      )
    }

    if (file.size > GLOBAL_MAX_FILE_SIZE_BYTES) {
      const limitMB = GLOBAL_MAX_FILE_SIZE_BYTES / (1024 * 1024)
      const fileMB = (file.size / (1024 * 1024)).toFixed(1)
      return createErrorResponse(
        ErrorCodes.BAD_REQUEST,
        `File size (${fileMB} MB) exceeds the maximum allowed size of ${limitMB} MB.`,
        400
      )
    }

    // ── Per-project storage quota check (before reading buffer) ──────────
    await assertQuotaAvailable(context.projectId, file.size)

    // ── Resolve bucket (auto-create 'default' if needed) ─────────────────
    let bucketRecord = await prisma.storageBucket.findFirst({
      where: { projectId: context.projectId, name: bucketName },
    })

    if (!bucketRecord) {
      if (bucketName === 'default') {
        // Auto-create a 'default' bucket so SDK users never hit a 404
        bucketRecord = await prisma.storageBucket.create({
          data: { name: 'default', projectId: context.projectId, isPublic: false },
        })
      } else {
        return createErrorResponse(
          ErrorCodes.NOT_FOUND,
          `Bucket '${bucketName}' not found in this project`,
          404
        )
      }
    }

    // ── Read file into buffer ─────────────────────────────────────────────
    const arrayBuffer = await file.arrayBuffer()
    let buffer: Buffer = Buffer.from(new Uint8Array(arrayBuffer))
    let finalMimeType = mimeType
    let finalPath = filePath

    // ── Optional image processing ─────────────────────────────────────────
    const qs = request.nextUrl.searchParams
    const hasProcessingParams = qs.has('width') || qs.has('height') || qs.has('format') || qs.has('quality')

    if (hasProcessingParams) {
      const result = await processImage(buffer, mimeType, {
        width:   qs.has('width')   ? parseInt(qs.get('width')!, 10)   : undefined,
        height:  qs.has('height')  ? parseInt(qs.get('height')!, 10)  : undefined,
        format:  qs.get('format') as any ?? undefined,
        quality: qs.has('quality') ? parseInt(qs.get('quality')!, 10) : undefined,
      })

      if (result.processed) {
        buffer = result.buffer
        finalMimeType = result.mimeType

        // Update file extension in path if format changed
        if (result.mimeType !== mimeType) {
          const newExt = mimeToExtension(result.mimeType)
          if (newExt) {
            const currentExt = path.extname(finalPath)
            finalPath = currentExt
              ? finalPath.slice(0, -currentExt.length) + newExt
              : finalPath + newExt
          }
        }

        console.log(
          `[Storage] Image processed: ${(result.originalSize / 1024).toFixed(0)}KB → ` +
          `${(result.finalSize / 1024).toFixed(0)}KB (${Math.round((1 - result.finalSize / result.originalSize) * 100)}% reduction)`
        )
      }
    }

    // ── Upload to storage service ─────────────────────────────────────────
    const fileRecord = await storageService.uploadFile(
      bucketRecord.id,
      { name: finalPath, buffer, mimeType: finalMimeType },
      { isPublic, projectId: context.projectId, uploadedBy: context.apiKey.userId }
    )


    return createSuccessResponse({
      id: fileRecord.id,
      bucket: bucketRecord.name,
      path: fileRecord.path,
      url: fileRecord.url,
      size: Number(fileRecord.size),
      contentType: finalMimeType,
      isPublic: isPublic || bucketRecord.isPublic,
    })
  } catch (error: any) {
    if (error instanceof QuotaExceededError) {
      return createErrorResponse(ErrorCodes.FORBIDDEN, error.message, 413)
    }

    console.error('Storage upload error:', error)

    // Surface validation errors from the storage service as 400, not 500
    if (
      error.message?.includes('not allowed') ||
      error.message?.includes('exceeds') ||
      error.message?.includes('quota') ||
      error.message?.includes('spoofing') ||
      error.message?.includes('already exists')
    ) {
      return createErrorResponse(ErrorCodes.BAD_REQUEST, error.message, 400)
    }

    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, 'Failed to upload file', 500)
  }
}

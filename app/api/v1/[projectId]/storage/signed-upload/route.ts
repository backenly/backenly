export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { v1ApiMiddleware, requirePermission } from '@/lib/api/v1/middleware'
import { createErrorResponse, createSuccessResponse, ErrorCodes } from '@/lib/api/v1/errors'
import { prisma } from '@/lib/db'
import { assertQuotaAvailable, QuotaExceededError } from '@/lib/services/storageQuota'
import { getS3Client, getS3Config, isS3Configured } from '@/lib/services/s3-config'
import crypto from 'crypto'

const ALLOWED_VIDEO_TYPES = new Set([
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
  'video/x-msvideo', 'video/x-matroska', 'video/3gpp',
])
const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'image/svg+xml', 'image/avif',
])
const ALLOWED_AUDIO_TYPES = new Set([
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/flac',
  'audio/aac', 'audio/webm',
])
const MAX_SIGNED_UPLOAD_BYTES = parseInt(
  process.env.STORAGE_SIGNED_MAX_BYTES || String(2 * 1024 * 1024 * 1024), // 2 GB default
  10
)
const SIGNED_URL_TTL_SECONDS = parseInt(
  process.env.STORAGE_SIGNED_URL_TTL || '900', // 15 minutes default
  10
)

/**
 * POST /v1/{projectId}/storage/signed-upload
 *
 * Generate a pre-signed URL for a direct client-to-storage upload.
 * Best for large files (videos, 3D assets) that would be impractical
 * to stream through the application server.
 *
 * When STORAGE_DRIVER=s3: returns a real AWS S3 pre-signed PUT URL so the
 * client uploads directly to S3 — the server is not in the upload path.
 *
 * When STORAGE_DRIVER=local (development): returns a one-time upload token
 * that can be used with POST /v1/{projectId}/storage/upload.
 *
 * Body: {
 *   filename: string,        // e.g. "clip_001.mp4"
 *   contentType: string,     // MIME type, e.g. "video/mp4"
 *   contentLength: number,   // file size in bytes
 *   bucket?: string,         // default: "videos"
 *   path?: string,           // optional path prefix inside bucket
 *   isPublic?: boolean,      // default: false
 * }
 *
 * Response: {
 *   uploadUrl: string,       // PUT to this URL directly from the client
 *   fileId: string,          // record created in DB — use to track the upload
 *   fields?: object,         // S3 POST policy fields (only for POST-policy uploads)
 *   expiresAt: string,       // ISO timestamp when the URL expires
 *   method: 'PUT' | 'POST',
 *   maxBytes: number,
 * }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string } }
) {
  try {
    const middleware = await v1ApiMiddleware(request, params)
    if (middleware.response) return middleware.response

    const { context } = middleware

    const permCheck = requirePermission(context, ['write', 'admin'])
    if (permCheck) return permCheck

    // ── Parse & validate body ─────────────────────────────────────────────
    let body: any
    try {
      body = await request.json()
    } catch {
      return createErrorResponse(ErrorCodes.BAD_REQUEST, 'Request body must be JSON', 400)
    }

    const { filename, contentType, contentLength, bucket: bucketName = 'videos', path: pathPrefix = '', isPublic = false } = body

    if (!filename || typeof filename !== 'string') {
      return createErrorResponse(ErrorCodes.BAD_REQUEST, '"filename" is required', 400)
    }
    if (!contentType || typeof contentType !== 'string') {
      return createErrorResponse(ErrorCodes.BAD_REQUEST, '"contentType" is required', 400)
    }
    if (typeof contentLength !== 'number' || contentLength <= 0) {
      return createErrorResponse(ErrorCodes.BAD_REQUEST, '"contentLength" must be a positive number', 400)
    }
    if (contentLength > MAX_SIGNED_UPLOAD_BYTES) {
      const limitGB = (MAX_SIGNED_UPLOAD_BYTES / (1024 ** 3)).toFixed(1)
      return createErrorResponse(
        ErrorCodes.BAD_REQUEST,
        `File size (${(contentLength / (1024 ** 2)).toFixed(0)} MB) exceeds the maximum allowed size of ${limitGB} GB.`,
        400
      )
    }

    const isAllowedType =
      ALLOWED_VIDEO_TYPES.has(contentType) ||
      ALLOWED_IMAGE_TYPES.has(contentType) ||
      ALLOWED_AUDIO_TYPES.has(contentType) ||
      contentType === 'application/octet-stream'
    if (!isAllowedType) {
      return createErrorResponse(
        ErrorCodes.BAD_REQUEST,
        `Content type "${contentType}" is not supported for signed upload. Use /storage/upload for other file types.`,
        400
      )
    }

    // ── Per-project storage quota check ──────────────────────────────────
    try {
      await assertQuotaAvailable(context.projectId, contentLength)
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        return createErrorResponse(ErrorCodes.FORBIDDEN, err.message, 413)
      }
      throw err
    }

    // ── Resolve / auto-create bucket ──────────────────────────────────────
    let bucketRecord = await prisma.storageBucket.findFirst({
      where: { projectId: context.projectId, name: bucketName },
    })
    if (!bucketRecord) {
      bucketRecord = await prisma.storageBucket.create({
        data: {
          name: bucketName,
          projectId: context.projectId,
          isPublic: Boolean(isPublic),
        },
      })
    }

    // ── Build storage path ────────────────────────────────────────────────
    const safeFilename = filename.replace(/[^a-zA-Z0-9._\-]/g, '_')
    const uploadId = crypto.randomUUID()
    const storagePath = [
      pathPrefix.replace(/^\/+|\/+$/g, ''),
      uploadId,
      safeFilename,
    ].filter(Boolean).join('/')

    const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000)

    // ── S3 pre-signed URL (production path) ───────────────────────────────
    if (process.env.STORAGE_DRIVER === 's3' && isS3Configured()) {
      try {
        const { PutObjectCommand } = await import('@aws-sdk/client-s3')
        const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner')

        // Shared client + config — correct region for Backblaze/AWS (see s3-config.ts).
        const s3Client = getS3Client()
        const { bucket: s3Bucket } = getS3Config()

        const s3Key = `projects/${context.projectId}/buckets/${bucketName}/${storagePath}`
        const command = new PutObjectCommand({
          Bucket: s3Bucket,
          Key: s3Key,
          ContentType: contentType,
          ContentLength: contentLength,
          Metadata: {
            projectId: context.projectId,
            bucketId: bucketRecord.id,
            uploadId,
          },
        })

        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: SIGNED_URL_TTL_SECONDS })

        // Create a pending file record in DB so we can track the upload.
        //
        // CRITICAL: `path` MUST equal the S3 object key the client PUTs to.
        // The download layer (S3StorageService.getFile / getFileUrl) uses
        // `path` verbatim as the S3 Key. Previously we stored the shorter
        // `storagePath` (missing the `projects/{pid}/buckets/{bucket}/` prefix),
        // so every signed upload resolved to a non-existent key → NoSuchKey →
        // undownloadable. The real download URL is minted at confirm-upload
        // time via getFileUrl, so we no longer store a bogus amazonaws.com URL.
        const fileRecord = await prisma.storageFile.create({
          data: {
            bucketId: bucketRecord.id,
            projectId: context.projectId,
            name: safeFilename,
            path: s3Key,
            size: BigInt(contentLength),
            mimeType: contentType,
            isPublic: Boolean(isPublic),
            metadata: { uploadId, status: 'pending', s3Key },
          },
        })

        return createSuccessResponse({
          uploadUrl,
          fileId: fileRecord.id,
          expiresAt: expiresAt.toISOString(),
          method: 'PUT',
          maxBytes: MAX_SIGNED_UPLOAD_BYTES,
          storagePath,
          instructions: 'PUT the file directly to uploadUrl with the correct Content-Type header. No authentication header needed.',
        })
      } catch (s3Err: any) {
        console.error('[SignedUpload] S3 pre-sign error:', s3Err)
        // Fall through to local token fallback
      }
    }

    // ── Local / development fallback ──────────────────────────────────────
    // Issue a one-time token that the client uses with POST /storage/upload.
    // This is NOT production-grade for large files but works in dev/staging.
    const oneTimeToken = crypto.randomBytes(32).toString('hex')
    const tokenExpiry = expiresAt.toISOString()

    // Store token in DB (or in-memory cache in production you'd use Redis)
    await prisma.storageFile.create({
      data: {
        bucketId: bucketRecord.id,
        projectId: context.projectId,
        name: safeFilename,
        path: storagePath,
        size: BigInt(contentLength),
        mimeType: contentType,
        isPublic: Boolean(isPublic),
        metadata: { uploadId, status: 'pending', oneTimeToken, tokenExpiry },
      },
    }).catch(() => null) // non-fatal if file record already exists

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

    return createSuccessResponse({
      uploadUrl: `${appUrl}/api/v1/${context.projectId}/storage/upload`,
      uploadToken: oneTimeToken,
      fileId: uploadId,
      expiresAt: tokenExpiry,
      method: 'POST',
      maxBytes: MAX_SIGNED_UPLOAD_BYTES,
      storagePath,
      note: process.env.STORAGE_DRIVER !== 's3'
        ? 'Development mode: upload via POST /storage/upload with this token. Configure STORAGE_DRIVER=s3 for production direct-to-S3 uploads.'
        : 'S3 credentials not configured — see STORAGE_S3_BUCKET, STORAGE_S3_REGION, STORAGE_S3_ENDPOINT env vars.',
    })
  } catch (error: any) {
    console.error('[SignedUpload] Error:', error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, 'Failed to generate signed upload URL', 500)
  }
}

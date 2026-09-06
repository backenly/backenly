export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { v1ApiMiddleware, requirePermission } from '@/lib/api/v1/middleware'
import { createErrorResponse, createSuccessResponse, ErrorCodes } from '@/lib/api/v1/errors'
import { prisma } from '@/lib/db'
import { assertQuotaAvailable, incrementStorageUsed, QuotaExceededError } from '@/lib/services/storageQuota'
import { getS3Client, getS3Config, isS3Configured } from '@/lib/services/s3-config'
import crypto from 'crypto'
import path from 'path'
import fs from 'fs/promises'
import os from 'os'

const CHUNK_UPLOAD_DIR = process.env.CHUNK_TEMP_DIR || path.join(os.tmpdir(), 'backenly-chunks')
// Maximum total assembled file size (2 GB)
const MAX_ASSEMBLED_BYTES = parseInt(
  process.env.STORAGE_SIGNED_MAX_BYTES || String(2 * 1024 * 1024 * 1024),
  10
)
// Maximum individual chunk size (10 MB)
const MAX_CHUNK_BYTES = 10 * 1024 * 1024

// uploadId comes from the URL; without validation it can be `../../etc/...`
// and path.join() won't confine it. We accept ONLY UUIDs (the form we mint).
const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isValidUploadId(id: string): boolean {
  return typeof id === 'string' && UPLOAD_ID_RE.test(id)
}

/**
 * Resolve a chunk dir/file path and assert it stays inside CHUNK_UPLOAD_DIR.
 * Defense-in-depth alongside UUID validation; a future change to uploadId
 * format will still be caught here.
 */
function safeChunkPath(uploadId: string, partFile?: string): string | null {
  if (!isValidUploadId(uploadId)) return null
  const root = path.resolve(CHUNK_UPLOAD_DIR)
  const target = partFile
    ? path.resolve(root, uploadId, partFile)
    : path.resolve(root, uploadId)
  const rel = path.relative(root, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return target
}

/**
 * Chunked / multipart upload for large video files.
 *
 * Three-step flow (mirrors the AWS S3 multipart API):
 *
 * 1. INITIATE  POST ?action=initiate  → returns { uploadId }
 * 2. UPLOAD    PUT  ?action=upload&uploadId=...&partNumber=1&totalParts=N  → upload chunk
 * 3. COMPLETE  POST ?action=complete&uploadId=...&totalParts=N  → assemble + store
 *
 * Abort: DELETE ?uploadId=...  — cleans up temp chunks.
 *
 * When STORAGE_DRIVER=s3 the initiation step creates a real S3 multipart
 * upload and each subsequent part is uploaded directly to S3 via a pre-signed
 * URL — the server is not in the upload path for individual chunks.
 */

// ── INITIATE ──────────────────────────────────────────────────────────────────
async function handleInitiate(request: NextRequest, context: { projectId: string; apiKey: any }) {
  let body: any
  try { body = await request.json() } catch {
    return createErrorResponse(ErrorCodes.BAD_REQUEST, 'Request body must be JSON', 400)
  }

  const { filename, contentType, contentLength, bucket: bucketName = 'videos', isPublic = false } = body

  if (!filename || !contentType || !contentLength) {
    return createErrorResponse(ErrorCodes.BAD_REQUEST, 'filename, contentType, and contentLength are required', 400)
  }
  if (contentLength > MAX_ASSEMBLED_BYTES) {
    const limitGB = (MAX_ASSEMBLED_BYTES / (1024 ** 3)).toFixed(1)
    return createErrorResponse(ErrorCodes.BAD_REQUEST, `File exceeds ${limitGB} GB limit`, 400)
  }

  // Per-project storage quota check before initiating the upload
  try {
    await assertQuotaAvailable(context.projectId, contentLength)
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return createErrorResponse(ErrorCodes.FORBIDDEN, err.message, 413)
    }
    throw err
  }

  let bucketRecord = await prisma.storageBucket.findFirst({
    where: { projectId: context.projectId, name: bucketName },
  })
  if (!bucketRecord) {
    bucketRecord = await prisma.storageBucket.create({
      data: { name: bucketName, projectId: context.projectId, isPublic: Boolean(isPublic), maxFileSizeBytes: BigInt(MAX_ASSEMBLED_BYTES) },
    })
  }

  // S3 multipart initiation
  if (process.env.STORAGE_DRIVER === 's3' && isS3Configured()) {
    try {
      const { CreateMultipartUploadCommand } = await import('@aws-sdk/client-s3')
      const s3 = getS3Client()
      const { bucket: s3Bucket } = getS3Config()
      const safeFilename = filename.replace(/[^a-zA-Z0-9._\-]/g, '_')
      const uploadId = crypto.randomUUID()
      const s3Key = `projects/${context.projectId}/buckets/${bucketName}/${uploadId}/${safeFilename}`
      const cmd = new CreateMultipartUploadCommand({
        Bucket: s3Bucket,
        Key: s3Key,
        ContentType: contentType,
        Metadata: { projectId: context.projectId, bucketId: bucketRecord.id },
      })
      const { UploadId: s3UploadId } = await s3.send(cmd)

      // Store pending file record.
      // CRITICAL: `path` must equal the S3 object key (the download layer uses
      // it verbatim as the Key). Storing the shorter `{uploadId}/{filename}`
      // made completed multipart uploads undownloadable → NoSuchKey.
      const fileRecord = await prisma.storageFile.create({
        data: {
          bucketId: bucketRecord.id,
          projectId: context.projectId,
          name: safeFilename,
          path: s3Key,
          size: BigInt(contentLength),
          mimeType: contentType,
          isPublic: Boolean(isPublic),
          metadata: { uploadId, s3UploadId, s3Key, status: 'uploading' },
        },
      })

      return createSuccessResponse({
        uploadId,
        fileId: fileRecord.id,
        s3UploadId,
        bucket: bucketName,
        driver: 's3',
        instructions: 'Upload each part via PUT /storage/upload-multipart?action=upload&uploadId=...&partNumber=N&totalParts=N then call ?action=complete',
      })
    } catch (err: any) {
      console.error('[Multipart] S3 initiate error:', err)
    }
  }

  // Local temp-file fallback
  const uploadId = crypto.randomUUID()
  const safeFilename = filename.replace(/[^a-zA-Z0-9._\-]/g, '_')
  const chunkDir = path.join(CHUNK_UPLOAD_DIR, uploadId)
  await fs.mkdir(chunkDir, { recursive: true })

  await prisma.storageFile.create({
    data: {
      bucketId: bucketRecord.id,
      projectId: context.projectId,
      name: safeFilename,
      path: `${uploadId}/${safeFilename}`,
      size: BigInt(contentLength),
      mimeType: contentType,
      isPublic: Boolean(isPublic),
      metadata: { uploadId, chunkDir, status: 'uploading', contentType, bucketId: bucketRecord.id },
    },
  })

  return createSuccessResponse({
    uploadId,
    bucket: bucketName,
    driver: 'local',
    instructions: 'Upload each chunk via PUT ?action=upload&uploadId=...&partNumber=N&totalParts=N then call POST ?action=complete',
    note: process.env.STORAGE_DRIVER !== 's3' ? 'Configure STORAGE_DRIVER=s3 for production large-file support.' : undefined,
  })
}

// ── UPLOAD CHUNK ──────────────────────────────────────────────────────────────
async function handleUploadChunk(request: NextRequest, uploadId: string, partNumber: number, totalParts: number, projectId: string) {
  if (!uploadId || partNumber < 1 || totalParts < 1) {
    return createErrorResponse(ErrorCodes.BAD_REQUEST, 'uploadId, partNumber, and totalParts are required', 400)
  }
  if (!isValidUploadId(uploadId)) {
    return createErrorResponse(ErrorCodes.BAD_REQUEST, 'Invalid uploadId', 400)
  }
  // partNumber bounded to a sane range — prevents 0-padded filenames being
  // crafted to escape via prefix tricks (defense-in-depth alongside isValidUploadId).
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
    return createErrorResponse(ErrorCodes.BAD_REQUEST, 'partNumber out of range', 400)
  }
  if (!Number.isInteger(totalParts) || totalParts < 1 || totalParts > 10_000) {
    return createErrorResponse(ErrorCodes.BAD_REQUEST, 'totalParts out of range', 400)
  }

  // The fileRecord lookup binds uploadId ↔ projectId, so a caller with a
  // valid API key can't write into another tenant's session.
  const fileRecord = await prisma.storageFile.findFirst({
    where: { projectId, metadata: { path: ['uploadId'], equals: uploadId } },
  }).catch(() => null)
  if (!fileRecord) {
    return createErrorResponse(ErrorCodes.NOT_FOUND, 'Upload session not found', 404)
  }

  const chunkBuffer = Buffer.from(await request.arrayBuffer())
  if (chunkBuffer.length > MAX_CHUNK_BYTES) {
    return createErrorResponse(ErrorCodes.BAD_REQUEST, `Chunk exceeds ${MAX_CHUNK_BYTES / (1024 * 1024)} MB limit`, 400)
  }

  // S3: upload part via pre-signed URL (fileRecord already fetched above)
  if (process.env.STORAGE_DRIVER === 's3' && isS3Configured()) {
    if (fileRecord) {
      const meta: any = fileRecord.metadata || {}
      try {
        const { UploadPartCommand } = await import('@aws-sdk/client-s3')
        const s3 = getS3Client()
        const { bucket: s3Bucket } = getS3Config()
        const result = await s3.send(new UploadPartCommand({
          Bucket: s3Bucket,
          Key: meta.s3Key,
          UploadId: meta.s3UploadId,
          PartNumber: partNumber,
          Body: chunkBuffer,
        }))
        return createSuccessResponse({ partNumber, etag: result.ETag, uploaded: chunkBuffer.length })
      } catch (err: any) {
        return createErrorResponse(ErrorCodes.INTERNAL_ERROR, `S3 part upload failed: ${err.message}`, 500)
      }
    }
  }

  // Local: write chunk to temp dir. Resolve + confine; reject if escape.
  const chunkDir = safeChunkPath(uploadId)
  const chunkPath = safeChunkPath(uploadId, `part_${String(partNumber).padStart(5, '0')}`)
  if (!chunkDir || !chunkPath) {
    return createErrorResponse(ErrorCodes.BAD_REQUEST, 'Invalid chunk path', 400)
  }
  await fs.mkdir(chunkDir, { recursive: true })
  await fs.writeFile(chunkPath, chunkBuffer)

  return createSuccessResponse({ partNumber, uploaded: chunkBuffer.length })
}

// ── COMPLETE ──────────────────────────────────────────────────────────────────
async function handleComplete(request: NextRequest, uploadId: string, totalParts: number, projectId: string) {
  if (!uploadId || totalParts < 1) {
    return createErrorResponse(ErrorCodes.BAD_REQUEST, 'uploadId and totalParts are required', 400)
  }
  if (!isValidUploadId(uploadId)) {
    return createErrorResponse(ErrorCodes.BAD_REQUEST, 'Invalid uploadId', 400)
  }
  if (!Number.isInteger(totalParts) || totalParts > 10_000) {
    return createErrorResponse(ErrorCodes.BAD_REQUEST, 'totalParts out of range', 400)
  }

  const fileRecord = await prisma.storageFile.findFirst({
    where: { projectId, metadata: { path: ['uploadId'], equals: uploadId } },
  }).catch(() => null)

  if (!fileRecord) {
    return createErrorResponse(ErrorCodes.NOT_FOUND, 'Upload session not found', 404)
  }

  const meta: any = fileRecord.metadata || {}

  // S3: complete multipart upload
  if (process.env.STORAGE_DRIVER === 's3' && isS3Configured() && meta.s3UploadId) {
    let etags: any[] = []
    try {
      const body = await request.json()
      etags = body.parts || []
    } catch {
      return createErrorResponse(ErrorCodes.BAD_REQUEST, 'Body must be { parts: [{ partNumber, etag }] }', 400)
    }

    const { CompleteMultipartUploadCommand } = await import('@aws-sdk/client-s3')
    const s3 = getS3Client()
    const { bucket: s3Bucket } = getS3Config()
    const completeCmd = new CompleteMultipartUploadCommand({
      Bucket: s3Bucket,
      Key: meta.s3Key,
      UploadId: meta.s3UploadId,
      MultipartUpload: { Parts: etags.map(p => ({ PartNumber: p.partNumber, ETag: p.etag })) },
    })
    await s3.send(completeCmd)

    // Real, resolvable URL — `path` equals the S3 key so getFileUrl presigns
    // (or returns the public CDN URL for) the exact assembled object. The old
    // hardcoded `{bucket}.s3.amazonaws.com` URL was wrong on Backblaze/R2 and
    // inaccessible for private buckets.
    const { storageService } = await import('@/lib/services/storage')
    let url: string | null = null
    try {
      url = await storageService.getFileUrl(fileRecord.id, projectId)
    } catch (err: any) {
      console.warn('[Multipart] Could not generate file URL:', err?.message)
    }
    await prisma.storageFile.update({
      where: { id: fileRecord.id },
      data: { metadata: { ...meta, url, status: 'complete' } },
    })
    // Track storage usage (non-blocking)
    if (fileRecord.size) {
      incrementStorageUsed(projectId, fileRecord.size).catch(
        (err: any) => console.warn('[Storage] Failed to increment storage usage:', err?.message)
      )
    }
    return createSuccessResponse({ id: fileRecord.id, url, path: fileRecord.path })
  }

  // Local: assemble chunks into final file. We re-derive the chunk dir from
  // the validated uploadId — ignore meta.chunkDir, which used to be trusted
  // from the DB (still attacker-influenceable if a session was tampered).
  const { storageService } = await import('@/lib/services/storage')
  const chunkDir = safeChunkPath(uploadId)
  if (!chunkDir) {
    return createErrorResponse(ErrorCodes.BAD_REQUEST, 'Invalid uploadId', 400)
  }
  const parts: Buffer[] = []
  for (let i = 1; i <= totalParts; i++) {
    const chunkPath = safeChunkPath(uploadId, `part_${String(i).padStart(5, '0')}`)
    if (!chunkPath) {
      return createErrorResponse(ErrorCodes.BAD_REQUEST, `Invalid chunk part ${i}`, 400)
    }
    try {
      parts.push(await fs.readFile(chunkPath))
    } catch {
      return createErrorResponse(ErrorCodes.BAD_REQUEST, `Missing chunk part ${i}`, 400)
    }
  }
  const assembled = Buffer.concat(parts)
  const bucket = await prisma.storageBucket.findUnique({ where: { id: fileRecord.bucketId } })
  if (!bucket) {
    return createErrorResponse(ErrorCodes.NOT_FOUND, 'Bucket not found', 404)
  }
  const storedFile = await storageService.uploadFile(
    bucket.id,
    { name: fileRecord.name, buffer: assembled, mimeType: fileRecord.mimeType || 'application/octet-stream' },
    { isPublic: fileRecord.isPublic, projectId, uploadedBy: '' }
  )
  // Clean up temp chunks
  fs.rm(chunkDir, { recursive: true, force: true }).catch(() => null)

  await prisma.storageFile.update({
    where: { id: fileRecord.id },
    data: { size: BigInt(assembled.length), metadata: { ...meta, url: storedFile.url, status: 'complete' } },
  })

  // Track storage usage (non-blocking)
  incrementStorageUsed(projectId, BigInt(assembled.length)).catch(
    (err: any) => console.warn('[Storage] Failed to increment storage usage:', err?.message)
  )

  return createSuccessResponse({ id: fileRecord.id, url: storedFile.url, path: fileRecord.path, size: assembled.length })
}

// ── Route dispatcher ───────────────────────────────────────────────────────────

export async function POST(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  const middleware = await v1ApiMiddleware(request, params)
  if (middleware.response) return middleware.response
  const { context } = middleware
  const permCheck = requirePermission(context, ['write', 'admin'])
  if (permCheck) return permCheck

  const action = request.nextUrl.searchParams.get('action')

  if (action === 'initiate') {
    return handleInitiate(request, context)
  }

  if (action === 'complete') {
    const uploadId = request.nextUrl.searchParams.get('uploadId') || ''
    const totalParts = parseInt(request.nextUrl.searchParams.get('totalParts') || '0', 10)
    return handleComplete(request, uploadId, totalParts, context.projectId)
  }

  return createErrorResponse(ErrorCodes.BAD_REQUEST, 'Use ?action=initiate or ?action=complete', 400)
}

export async function PUT(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  const middleware = await v1ApiMiddleware(request, params)
  if (middleware.response) return middleware.response
  const { context } = middleware
  const permCheck = requirePermission(context, ['write', 'admin'])
  if (permCheck) return permCheck

  const uploadId = request.nextUrl.searchParams.get('uploadId') || ''
  const partNumber = parseInt(request.nextUrl.searchParams.get('partNumber') || '0', 10)
  const totalParts = parseInt(request.nextUrl.searchParams.get('totalParts') || '0', 10)

  return handleUploadChunk(request, uploadId, partNumber, totalParts, context.projectId)
}

export async function DELETE(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  const middleware = await v1ApiMiddleware(request, params)
  if (middleware.response) return middleware.response
  const { context } = middleware

  const uploadId = request.nextUrl.searchParams.get('uploadId') || ''
  if (!uploadId) return createErrorResponse(ErrorCodes.BAD_REQUEST, 'uploadId is required', 400)
  if (!isValidUploadId(uploadId)) return createErrorResponse(ErrorCodes.BAD_REQUEST, 'Invalid uploadId', 400)

  const fileRecord = await prisma.storageFile.findFirst({
    where: { projectId: context.projectId, metadata: { path: ['uploadId'], equals: uploadId } },
  }).catch(() => null)

  if (fileRecord) {
    await prisma.storageFile.delete({ where: { id: fileRecord.id } }).catch(() => null)
    const meta: any = fileRecord.metadata || {}
    // Abort S3 multipart upload if applicable.
    // Previously this built `new S3Client({ region })` with NO endpoint and NO
    // credentials — so on Backblaze/R2 it pointed at AWS and silently failed,
    // leaking incomplete multipart uploads (which providers bill for). Use the
    // shared, fully-configured client.
    if (process.env.STORAGE_DRIVER === 's3' && meta.s3UploadId && meta.s3Key && isS3Configured()) {
      const { AbortMultipartUploadCommand } = await import('@aws-sdk/client-s3')
      const s3 = getS3Client()
      const { bucket: s3Bucket } = getS3Config()
      await s3.send(new AbortMultipartUploadCommand({
        Bucket: s3Bucket,
        Key: meta.s3Key,
        UploadId: meta.s3UploadId,
      })).catch(() => null)
    }
    // Clean up local temp dir — re-derive via safeChunkPath, ignore meta.chunkDir.
    const cleanupDir = safeChunkPath(uploadId)
    if (cleanupDir) {
      fs.rm(cleanupDir, { recursive: true, force: true }).catch(() => null)
    }
  }

  return createSuccessResponse({ aborted: true, uploadId })
}

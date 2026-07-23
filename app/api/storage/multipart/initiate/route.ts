export const dynamic = 'force-dynamic'

/**
 * POST /api/storage/multipart/initiate
 *
 * Start a multipart upload session (#73).
 * For large files (> 50 MB recommended, required for > 500 MB).
 *
 * Body:
 *   bucketId    string  — target bucket
 *   fileName    string  — final file name
 *   mimeType?   string  — MIME type
 *   totalSize   number  — total file size in bytes
 *   chunkSize?  number  — chunk size in bytes (default 10 MB, min 5 MB)
 *
 * Response:
 *   uploadId      string  — use in subsequent chunk/complete/abort calls
 *   totalChunks   number  — how many chunks to upload
 *   chunkSize     number  — chunk size to use
 */

import { NextRequest, NextResponse } from 'next/server'
import { withTenantIsolation, TenantIsolationError } from '@/lib/tenant/isolation'
import { prisma } from '@/lib/db/postgres'
import { assertQuotaAvailable } from '@/lib/services/storageQuota'
import { z } from 'zod'
import crypto from 'crypto'

const MIN_CHUNK_SIZE = 5  * 1024 * 1024  // 5 MB (S3 minimum for non-final parts)
const MAX_CHUNK_SIZE = 100 * 1024 * 1024  // 100 MB
const DEFAULT_CHUNK_SIZE = 10 * 1024 * 1024  // 10 MB
const MULTIPART_EXPIRY_HOURS = 24

const schema = z.object({
  bucketId:   z.string().min(1),
  fileName:   z.string().min(1).max(1024),
  mimeType:   z.string().optional(),
  totalSize:  z.number().int().positive(),
  chunkSize:  z.number().int().optional(),
})

export async function POST(request: NextRequest) {
  try {
    return await withTenantIsolation(request, async (projectId) => {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
      }

      const parse = schema.safeParse(body)
      if (!parse.success) {
        return NextResponse.json({ error: parse.error.errors[0].message }, { status: 400 })
      }

      const { bucketId, fileName, mimeType, totalSize, chunkSize: requestedChunkSize } = parse.data

      // Validate bucket belongs to project
      const bucket = await prisma.storageBucket.findFirst({
        where: { id: bucketId, projectId },
      })
      if (!bucket) {
        return NextResponse.json({ error: 'Bucket not found' }, { status: 404 })
      }

      // Quota check
      try {
        await assertQuotaAvailable(projectId, totalSize)
      } catch (err: unknown) {
        if (err instanceof Error && err.constructor.name === 'QuotaExceededError') {
          return NextResponse.json(
            { error: err.message, code: 'QUOTA_EXCEEDED' },
            { status: 413 }
          )
        }
        throw err
      }

      // Determine chunk size
      const chunkSize = Math.min(
        Math.max(requestedChunkSize ?? DEFAULT_CHUNK_SIZE, MIN_CHUNK_SIZE),
        MAX_CHUNK_SIZE,
      )
      const totalChunks = Math.ceil(totalSize / chunkSize)

      const uploadId = crypto.randomUUID()
      const expiresAt = new Date(Date.now() + MULTIPART_EXPIRY_HOURS * 60 * 60 * 1000)

      await prisma.multipartUpload.create({
        data: {
          uploadId,
          projectId,
          bucketId,
          fileName,
          mimeType,
          totalSize: BigInt(totalSize),
          chunkSize,
          status: 'pending',
          parts: [],
          expiresAt,
        },
      })

      return NextResponse.json({
        uploadId,
        totalChunks,
        chunkSize,
        expiresAt: expiresAt.toISOString(),
      })
    })
  } catch (err) {
    if (err instanceof TenantIsolationError) {
      return NextResponse.json({ error: err.message }, { status: 403 })
    }
    console.error('[Multipart/initiate]', err)
    return NextResponse.json({ error: 'Failed to initiate upload' }, { status: 500 })
  }
}

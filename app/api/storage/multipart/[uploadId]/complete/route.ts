export const dynamic = 'force-dynamic'

/**
 * POST /api/storage/multipart/[uploadId]/complete
 *
 * Assemble all uploaded chunks into the final file (#73).
 *
 * Body: { parts: [{ partNumber: number, etag: string }] }
 *   — Client confirms which parts to include (should match what was uploaded)
 *
 * Response: same shape as a regular file upload
 */

import { NextRequest, NextResponse } from 'next/server'
import { withTenantIsolation, TenantIsolationError } from '@/lib/tenant/isolation'
import { prisma } from '@/lib/db/postgres'
import { incrementStorageUsed } from '@/lib/services/storageQuota'
import { scheduleFileProcessing } from '@/lib/services/storageProcessing'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { z } from 'zod'

const schema = z.object({
  parts: z.array(z.object({
    partNumber: z.number().int().positive(),
    etag: z.string().min(1),
  })),
})

const STORAGE_DIR = process.env.STORAGE_DIR || path.join(process.cwd(), 'storage')

export async function POST(request: NextRequest, props: { params: Promise<{ uploadId: string }> }) {
  const params = await props.params;
  try {
    return await withTenantIsolation(request, async (projectId) => {
      const { uploadId } = params

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

      const upload = await prisma.multipartUpload.findFirst({
        where: { uploadId, projectId, status: 'pending' },
        include: { bucket: true },
      })

      if (!upload) {
        return NextResponse.json({ error: 'Upload session not found' }, { status: 404 })
      }

      if (upload.expiresAt < new Date()) {
        await prisma.multipartUpload.update({ where: { id: upload.id }, data: { status: 'aborted' } })
        return NextResponse.json({ error: 'Upload session expired' }, { status: 410 })
      }

      // Verify all requested parts exist in temp storage
      const tmpDir = path.join(os.tmpdir(), 'backenly-multipart', uploadId)
      const sortedParts = parse.data.parts.sort((a, b) => a.partNumber - b.partNumber)

      for (const part of sortedParts) {
        const chunkPath = path.join(tmpDir, `part-${part.partNumber}`)
        try {
          await fs.access(chunkPath)
        } catch {
          return NextResponse.json(
            { error: `Chunk ${part.partNumber} is missing. Re-upload it before completing.` },
            { status: 400 }
          )
        }
      }

      // Assemble all chunks into the final file
      const bucketDir = path.join(STORAGE_DIR, upload.bucket.name)
      await fs.mkdir(bucketDir, { recursive: true })

      // Generate a unique filename to avoid collisions
      const ext = path.extname(upload.fileName)
      const base = path.basename(upload.fileName, ext)
      const uniqueName = `${base}_${crypto.randomBytes(4).toString('hex')}${ext}`
      const finalPath = path.join(bucketDir, uniqueName)

      const writeStream = await fs.open(finalPath, 'w')
      let totalBytes = 0

      try {
        for (const part of sortedParts) {
          const chunkPath = path.join(tmpDir, `part-${part.partNumber}`)
          const chunkData = await fs.readFile(chunkPath)
          await writeStream.write(chunkData)
          totalBytes += chunkData.length
        }
      } finally {
        await writeStream.close()
      }

      // Clean up temp chunks
      fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})

      // Create StorageFile record
      const storageFile = await prisma.storageFile.create({
        data: {
          bucketId:         upload.bucketId,
          projectId,
          name:             uniqueName,
          originalName:     upload.fileName,
          path:             finalPath,
          size:             BigInt(totalBytes),
          mimeType:         upload.mimeType,
          isPublic:         upload.bucket.accessPolicy === 'public_read' || upload.bucket.accessPolicy === 'cdn_cacheable',
          processingStatus: 'pending',
        },
      })

      // Update upload status
      await prisma.multipartUpload.update({
        where: { id: upload.id },
        data: { status: 'completed', totalSize: BigInt(totalBytes) },
      })

      // Increment project storage usage
      await incrementStorageUsed(projectId, BigInt(totalBytes))

      // Trigger post-upload processing
      if (upload.mimeType) {
        scheduleFileProcessing(storageFile.id, finalPath, upload.mimeType)
      }

      return NextResponse.json({
        success: true,
        file: {
          id:           storageFile.id,
          name:         storageFile.name,
          originalName: storageFile.originalName,
          size:         totalBytes,
          mimeType:     storageFile.mimeType,
          path:         storageFile.path,
        },
      })
    })
  } catch (err) {
    if (err instanceof TenantIsolationError) {
      return NextResponse.json({ error: err.message }, { status: 403 })
    }
    console.error('[Multipart/complete]', err)
    return NextResponse.json({ error: 'Failed to complete upload' }, { status: 500 })
  }
}

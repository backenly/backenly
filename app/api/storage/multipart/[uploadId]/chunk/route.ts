export const dynamic = 'force-dynamic'

/**
 * PUT /api/storage/multipart/[uploadId]/chunk?part=N
 *
 * Upload a single chunk (#73).
 *
 * Query params:
 *   part  number  — 1-based part number
 *
 * Body: raw binary (Content-Type can be anything)
 *
 * Response:
 *   partNumber  number
 *   size        number  — bytes received
 *   etag        string  — ETag of the stored chunk
 */

import { NextRequest, NextResponse } from 'next/server'
import { withTenantIsolation, TenantIsolationError } from '@/lib/tenant/isolation'
import { prisma } from '@/lib/db/postgres'
import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import os from 'os'

export async function PUT(request: NextRequest, props: { params: Promise<{ uploadId: string }> }) {
  const params = await props.params;
  try {
    return await withTenantIsolation(request, async (projectId) => {
      const { uploadId } = params
      const partStr = request.nextUrl.searchParams.get('part')
      const partNumber = parseInt(partStr ?? '', 10)

      if (!partNumber || partNumber < 1 || partNumber > 10000) {
        return NextResponse.json({ error: 'Invalid part number (1–10000)' }, { status: 400 })
      }

      const upload = await prisma.multipartUpload.findFirst({
        where: { uploadId, projectId, status: 'pending' },
      })

      if (!upload) {
        return NextResponse.json({ error: 'Upload session not found or already completed' }, { status: 404 })
      }

      if (upload.expiresAt < new Date()) {
        await prisma.multipartUpload.update({ where: { id: upload.id }, data: { status: 'aborted' } })
        return NextResponse.json({ error: 'Upload session expired' }, { status: 410 })
      }

      // Read chunk body
      const chunkBuffer = Buffer.from(await request.arrayBuffer())
      if (chunkBuffer.length === 0) {
        return NextResponse.json({ error: 'Empty chunk' }, { status: 400 })
      }

      // Write chunk to temp directory
      const tmpDir = path.join(os.tmpdir(), 'backenly-multipart', uploadId)
      await fs.mkdir(tmpDir, { recursive: true })
      const chunkPath = path.join(tmpDir, `part-${partNumber}`)
      await fs.writeFile(chunkPath, chunkBuffer)

      // Compute ETag (MD5 of chunk — matches S3 convention)
      const etag = crypto.createHash('md5').update(chunkBuffer).digest('hex')

      // Record this part in the DB (replace if already uploaded)
      const currentParts = (upload.parts as Array<{ partNumber: number; etag: string; size: number }>) ?? []
      const filteredParts = currentParts.filter((p) => p.partNumber !== partNumber)
      const updatedParts = [
        ...filteredParts,
        { partNumber, etag, size: chunkBuffer.length },
      ].sort((a, b) => a.partNumber - b.partNumber)

      await prisma.multipartUpload.update({
        where: { id: upload.id },
        data: { parts: updatedParts },
      })

      return NextResponse.json({ partNumber, size: chunkBuffer.length, etag })
    })
  } catch (err) {
    if (err instanceof TenantIsolationError) {
      return NextResponse.json({ error: err.message }, { status: 403 })
    }
    console.error('[Multipart/chunk]', err)
    return NextResponse.json({ error: 'Failed to upload chunk' }, { status: 500 })
  }
}

export const dynamic = 'force-dynamic'

/**
 * DELETE /api/storage/multipart/[uploadId]/abort
 *
 * Cancel an in-progress multipart upload and clean up temp chunks (#73).
 */

import { NextRequest, NextResponse } from 'next/server'
import { withTenantIsolation, TenantIsolationError } from '@/lib/tenant/isolation'
import { prisma } from '@/lib/db/postgres'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

export async function DELETE(
  request: NextRequest,
  { params }: { params: { uploadId: string } }
) {
  try {
    return await withTenantIsolation(request, async (projectId) => {
      const { uploadId } = params

      const upload = await prisma.multipartUpload.findFirst({
        where: { uploadId, projectId },
      })

      if (!upload) {
        return NextResponse.json({ error: 'Upload session not found' }, { status: 404 })
      }

      if (upload.status === 'completed') {
        return NextResponse.json({ error: 'Cannot abort a completed upload' }, { status: 409 })
      }

      // Mark as aborted
      await prisma.multipartUpload.update({
        where: { id: upload.id },
        data: { status: 'aborted' },
      })

      // Clean up temp chunks (fire and forget)
      const tmpDir = path.join(os.tmpdir(), 'backenly-multipart', uploadId)
      fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})

      return NextResponse.json({ message: 'Upload aborted successfully', uploadId })
    })
  } catch (err) {
    if (err instanceof TenantIsolationError) {
      return NextResponse.json({ error: err.message }, { status: 403 })
    }
    console.error('[Multipart/abort]', err)
    return NextResponse.json({ error: 'Failed to abort upload' }, { status: 500 })
  }
}

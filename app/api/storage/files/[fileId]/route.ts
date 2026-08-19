export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { storageService } from '@/lib/services/storage'
import { authenticateRequest } from '@/lib/auth/middleware'
import { withTenantIsolation, TenantIsolationError } from '@/lib/tenant/isolation'

/**
 * GET /api/storage/files/{fileId} — file metadata
 *
 * The route folder is `[fileId]`, so the dynamic segment is `params.fileId`.
 * (The previous `[fileId]/[versionId]` layout read `params.id`, a segment that
 * never existed — so every call resolved `undefined` and 404'd.)
 */
export async function GET(request: NextRequest, props: { params: Promise<{ fileId: string }> }) {
  const params = await props.params;
  try {
    return await withTenantIsolation(request, async (projectId) => {
      const files = await storageService.listFiles(undefined, projectId, { limit: 1000 })
      const file = files.find((f) => f.id === params.fileId)

      if (!file) {
        return NextResponse.json({ error: 'File not found' }, { status: 404 })
      }

      // BigInt → Number for JSON serialization
      return NextResponse.json({ file: { ...file, size: Number(file.size) } })
    })
  } catch (error: any) {
    if (error instanceof TenantIsolationError) {
      return NextResponse.json({ error: error.message }, { status: 403 })
    }
    console.error('Failed to get file:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to get file' },
      { status: 500 }
    )
  }
}

/**
 * DELETE /api/storage/files/{fileId} — delete a single file
 */
export async function DELETE(request: NextRequest, props: { params: Promise<{ fileId: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticateRequest(request)
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    return await withTenantIsolation(request, async (projectId) => {
      await storageService.deleteFile(params.fileId, projectId)
      return NextResponse.json({ success: true })
    })
  } catch (error: any) {
    if (error instanceof TenantIsolationError) {
      return NextResponse.json({ error: error.message }, { status: 403 })
    }
    console.error('Failed to delete file:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to delete file' },
      { status: 500 }
    )
  }
}

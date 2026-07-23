export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { storageService } from '@/lib/services/storage'
import { withTenantIsolation, TenantIsolationError } from '@/lib/tenant/isolation'

// DELETE /api/storage/files/bulk - Delete multiple files
export async function DELETE(request: NextRequest) {
  try {
    return await withTenantIsolation(request, async (projectId) => {
      const body = await request.json()
      const { fileIds } = body

      if (!Array.isArray(fileIds) || fileIds.length === 0) {
        return NextResponse.json(
          { error: 'fileIds array is required' },
          { status: 400 }
        )
      }

      await storageService.deleteFiles(fileIds, projectId)

      return NextResponse.json({ success: true })
    })
  } catch (error: any) {
    if (error instanceof TenantIsolationError) {
      return NextResponse.json(
        { error: error.message },
        { status: 403 }
      )
    }
    console.error('Failed to delete files:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to delete files' },
      { status: 500 }
    )
  }
}


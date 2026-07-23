export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/middleware'
import { prisma } from '@/lib/db/postgres'
import { getCurrentProjectId } from '@/lib/tenant/isolation'

/**
 * Delete file from workspace
 */
export async function DELETE(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const projectId = await getCurrentProjectId(request)
    
    if (!projectId) {
      return NextResponse.json({ error: 'No project selected' }, { status: 400 })
    }
    
    const { filePath } = await request.json()
    
    // Delete file from database
    // @ts-ignore - Prisma client will include this after restart
    await prisma.workspaceFile.delete({
      where: {
        projectId_path: {
          projectId,
          path: filePath
        }
      }
    })
    
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Delete file error:', error)
    return NextResponse.json({ error: 'Failed to delete file' }, { status: 500 })
  }
}

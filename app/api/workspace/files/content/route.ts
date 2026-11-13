export const dynamic = 'force-dynamic'

import { isEnvFile, realPathInsideWorkspace, resolveInsideWorkspace } from '@/lib/workspace/paths'
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/middleware'
import { roleRefusal } from '@/lib/auth/project-floor'
import { prisma } from '@/lib/db/postgres'
import { canAdministerProject } from '@/lib/edition/guard'
import { getCurrentProjectId } from '@/lib/tenant/isolation'

/**
 * Get file content from workspace
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const projectId = await getCurrentProjectId(request)
    
    if (!projectId) {
      return NextResponse.json({ error: 'No project selected' }, { status: 400 })
    }

    // A workspace file can be the project's `.env`: Admin and above, like the
    // workspace download.
    if (!(await canAdministerProject(user.userId, projectId))) {
      return roleRefusal(request.method)
    }

    const { filePath } = await request.json()

    // The path names a file in this project's workspace, and only there.
    const fsPath =
      typeof filePath === 'string' ? resolveInsideWorkspace(projectId, filePath.replace(/^workspace\//, '')) : null
    if (!fsPath) {
      return NextResponse.json(
        { error: "That file is not in this project's workspace.", code: 'PATH_OUTSIDE_WORKSPACE' },
        { status: 400 },
      )
    }

    // An environment file holds credentials: never served, from disk or from
    // the database copy.
    if (isEnvFile(filePath)) {
      return NextResponse.json(
        { error: 'Environment files are not served from a workspace.', code: 'ENV_FILE_NOT_SERVED' },
        { status: 403 },
      )
    }

    // CRITICAL FIX: Always try to read from file system first (for all files, not just .prisma)
    // This ensures we get the latest content even if DB is not synced yet
    try {
      const fs = await import('fs/promises')

      // A symbolic link in the workspace is read only when it leads to a file
      // that is in the workspace too.
      if (!(await realPathInsideWorkspace(projectId, fsPath))) {
        throw new Error('not a file in the workspace')
      }

      console.log('[File Content] Trying to read from file system: ' + fsPath)
      const content = await fs.readFile(fsPath, 'utf-8')
      console.log('[File Content] FS read success! Length: ' + content.length + ', has newlines: ' + content.includes('\n'))
      
      // Successfully read from FS, return it
      if (content && content.length > 0) {
        return NextResponse.json({ content })
      }
    } catch (fsError: any) {
      console.log('[File Content] FS read failed (will try DB): ' + fsError.message)
      // Continue to database fallback below
    }
    
    // Fetch file from database
    // @ts-ignore - Prisma client will include this after restart
    const file = await prisma.workspaceFile.findUnique({
      where: {
        projectId_path: {
          projectId,
          path: filePath
        }
      }
    })
    
    if (!file) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 })
    }
    
    // Debug: Log content info
    console.log('[File Content] Raw content length: ' + file.content.length)
    console.log('[File Content] Has real newlines: ' + file.content.includes('\n'))
    console.log('[File Content] Has escaped newlines: ' + file.content.includes('\\n'))
    console.log('[File Content] First 100 chars: ' + JSON.stringify(file.content.substring(0, 100)))
    
    // Fix: Ensure newlines are properly formatted
    // If content has literal \n (escaped), convert to actual newlines
    let content = file.content
    
    // Check if content has escaped newlines (\n as literal text)
    if (content && content.includes('\\n') && !content.includes('\n')) {
      console.log('[File Content] Detected escaped newlines, fixing...')
      // This is double-escaped - unescape it
      content = content.replace(/\\n/g, '\n')
    }
    
    // Additional fix: Sometimes content has single-escaped newlines that need fixing
    if (content && content.includes('\n') && content.indexOf('\n') < 50) {
      // If \n appears very early in the content, it might be escaped
      console.log('[File Content] Checking for single-escaped newlines...')
      const fixed = content.replace(/\n/g, '\n')
      if (fixed !== content) {
        console.log('[File Content] Fixed single-escaped newlines')
        content = fixed
      }
    }
    
    return NextResponse.json({ content })
  } catch (error) {
    console.error('Get file content error:', error)
    return NextResponse.json({ error: 'Failed to get file content' }, { status: 500 })
  }
}

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth/middleware'
import { promises as fs } from 'fs'
import path from 'path'
import archiver from 'archiver'
import { Readable } from 'stream'

// GET /api/workspace/download - Download entire project workspace as ZIP
export async function GET(request: NextRequest) {
  try {
    const auth = await authenticateRequest(request)
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const projectId = request.headers.get('X-Project-Id')
    if (!projectId) {
      return NextResponse.json(
        { error: 'Project ID is required' },
        { status: 400 }
      )
    }

    const workspacePath = path.join(process.cwd(), 'workspace', projectId)

    // Check if workspace directory exists
    try {
      await fs.access(workspacePath)
    } catch {
      return NextResponse.json(
        { error: 'Workspace not found' },
        { status: 404 }
      )
    }

    // Create a zip archive
    const archive = archiver('zip', {
      zlib: { level: 9 } // Maximum compression
    })

    // Create a promise to handle the archive
    const chunks: Buffer[] = []
    
    archive.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })

    // Recursively add all files from workspace directory
    await addDirectoryToArchive(archive, workspacePath, workspacePath)

    // Finalize the archive and wait for completion
    await new Promise<void>((resolve, reject) => {
      archive.on('end', () => resolve())
      archive.on('error', (err) => reject(err))
      archive.finalize()
    })

    // Combine all chunks into a single buffer
    const zipBuffer = Buffer.concat(chunks)

    // Set response headers for file download
    const headers = new Headers()
    headers.set('Content-Type', 'application/zip')
    headers.set(
      'Content-Disposition',
      `attachment; filename="${projectId}-workspace-${Date.now()}.zip"`
    )
    headers.set('Content-Length', zipBuffer.length.toString())

    return new NextResponse(zipBuffer, { headers })
  } catch (error: any) {
    console.error('Failed to create workspace archive:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to create workspace archive' },
      { status: 500 }
    )
  }
}

/**
 * Recursively add directory contents to archive
 */
async function addDirectoryToArchive(
  archive: archiver.Archiver,
  dirPath: string,
  basePath: string
): Promise<void> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      const relativePath = path.relative(basePath, fullPath).replace(/\\/g, '/') // Normalize path separators

      if (entry.isDirectory()) {
        // Recursively add subdirectories
        await addDirectoryToArchive(archive, fullPath, basePath)
      } else if (entry.isFile()) {
        // Add file to archive
        const fileContent = await fs.readFile(fullPath)
        archive.append(fileContent, { name: relativePath })
      }
    }
  } catch (error) {
    console.error(`Error reading directory ${dirPath}:`, error)
    throw error
  }
}


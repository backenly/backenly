export const dynamic = 'force-dynamic'

import { isEnvFile, projectWorkspaceDir } from '@/lib/workspace/paths'
import { NextRequest, NextResponse } from 'next/server'
import { withTenantIsolation, TenantIsolationError } from '@/lib/tenant/isolation'
import { promises as fs } from 'fs'
import path from 'path'
import archiver from 'archiver'
import { Readable } from 'stream'

// GET /api/workspace/download - Download entire project workspace as ZIP
//
// The ZIP is the project's generated workspace on disk, which can hold its
// `.env`, so reading it is a tenant boundary. The project id arrives in the
// `X-Project-Id` header, a request and not a grant: `withTenantIsolation`
// resolves it for the caller and refuses a project they may not see.
//
// Because the archive can hold the `.env`, it needs the Admin role, like the
// project's other exports. A member below Admin gets 403
// PROJECT_ROLE_INSUFFICIENT.
export async function GET(request: NextRequest) {
  try {
    return await withTenantIsolation(request, (projectId) => workspaceArchive(projectId), {
      floor: 'administer',
    })
  } catch (error: any) {
    if (error instanceof TenantIsolationError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    console.error('Failed to create workspace archive:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to create workspace archive' },
      { status: 500 }
    )
  }
}

/** The project's workspace directory as a ZIP download; 404 when it has none. */
async function workspaceArchive(projectId: string): Promise<NextResponse> {
  const workspacePath = projectWorkspaceDir(projectId)

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
        // An environment file holds credentials: never archived.
        if (isEnvFile(entry.name)) continue
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


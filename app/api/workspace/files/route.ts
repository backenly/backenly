export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/middleware'
import { prisma } from '@/lib/db/postgres'
import { getCurrentProjectId } from '@/lib/tenant/isolation'

/**
 * Workspace Files API
 * Stores generated code files in the database for Monaco editor
 */

export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const projectId = await getCurrentProjectId(request)
    
    if (!projectId) {
      return NextResponse.json({ error: 'No project selected' }, { status: 400 })
    }
    
    // Fetch workspace files for this project from DATABASE
    // @ts-ignore - Prisma client will include this after restart
    const rawDbFiles = await prisma.workspaceFile.findMany({
      where: { projectId },
      orderBy: { path: 'asc' }
    })
    
    // CRITICAL FIX: Normalize all database file paths to start with 'workspace/'
    // This prevents duplicates where DB files appear at root and FS files appear in workspace folder
    const dbFiles = rawDbFiles.map((file: any) => {
      let normalizedPath = file.path
      // If path doesn't start with 'workspace/', add it
      if (!normalizedPath.startsWith('workspace/')) {
        normalizedPath = 'workspace/' + normalizedPath
        console.log('[DB Normalize] ' + file.path + ' → ' + normalizedPath)
      }
      return {
        ...file,
        path: normalizedPath
      }
    })
    
    // Debug: Log first DB file info
    if (dbFiles.length > 0) {
      const firstFile = dbFiles[0]
      console.log('[DB Files] First file: ' + firstFile.path)
      console.log('[DB Files] Content length: ' + firstFile.content.length)
      console.log('[DB Files] Has real newlines: ' + firstFile.content.includes('\n'))
      console.log('[DB Files] Has escaped newlines: ' + firstFile.content.includes('\\n'))
      console.log('[DB Files] First 100 chars: ' + JSON.stringify(firstFile.content.substring(0, 100)))
    }
    
    // Also scan FILE SYSTEM for files that might not be in DB yet
    const fs = await import('fs/promises')
    const path = await import('path')
    const workspaceDir = path.join(process.cwd(), 'workspace', projectId)
    
    const fileSystemFiles: any[] = []
    
    try {
      // Check if workspace directory exists
      await fs.access(workspaceDir)
      
      // Recursively scan directory
      const scanDirectory = async (dir: string, basePath: string = ''): Promise<void> => {
        const entries = await fs.readdir(dir, { withFileTypes: true })
        
        for (const entry of entries) {
          // CRITICAL: Skip node_modules, .git, and other non-source directories
          if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === '.next') {
            continue
          }
          
          const fullPath = path.join(dir, entry.name)
          const relativePath = basePath ? basePath + '/' + entry.name : entry.name
          
          if (entry.isDirectory()) {
            // Recursively scan subdirectories
            await scanDirectory(fullPath, relativePath)
          } else if (entry.isFile()) {
            // Skip binary files and non-text files
            const ext = entry.name.split('.').pop()?.toLowerCase()
            const binaryExtensions = ['exe', 'dll', 'so', 'dylib', 'bin', 'node', 'wasm', 'png', 'jpg', 'jpeg', 'gif', 'ico', 'svg', 'woff', 'woff2', 'ttf', 'eot', 'zip', 'tar', 'gz']
            const hasNoBinaryExtension = !binaryExtensions.includes(ext || '')
            
            // Also check if file has no extension (likely binary on Unix)
            const hasExtension = entry.name.includes('.')
            
            // Skip if it's likely a binary file
            if (!hasExtension || !hasNoBinaryExtension) {
              console.log('[FS Sync] Skipping binary/non-text file:', relativePath)
              continue
            }
            
            // Read file content from file system
            let content: string
            try {
              content = await fs.readFile(fullPath, 'utf-8')
            } catch (readError: any) {
              // If reading as UTF-8 fails, it's likely a binary file - skip it
              console.log('[FS Sync] Failed to read as UTF-8 (likely binary), skipping:', relativePath)
              continue
            }
            
            // Skip files larger than 1MB to avoid database bloat
            if (content.length > 1024 * 1024) {
              console.log('[FS Sync] Skipping large file (>1MB):', relativePath, 'Size:', content.length)
              continue
            }
            
            // Debug: Log content info
            console.log('[FS Sync] File: ' + relativePath + ', Length: ' + content.length)
            console.log('[FS Sync] Has real newlines: ' + content.includes('\n'))
            console.log('[FS Sync] Has escaped newlines: ' + content.includes('\\n'))
            
            // SPECIAL DEBUG for schema.prisma
            if (relativePath.includes('schema.prisma')) {
              console.log('[FS Sync PRISMA] First 300 chars: ' + JSON.stringify(content.substring(0, 300)))
              console.log('[FS Sync PRISMA] Char codes at positions 0-10:', Array.from(content.substring(0, 10)).map((c, i) => `${i}:${c.charCodeAt(0)}`).join(', '))
            }
            
            // Fix: Ensure newlines are properly formatted
            // If content has literal \n (escaped), convert to actual newlines
            let fixedContent = content
            if (content && content.includes('\\n') && !content.includes('\n')) {
              console.log('[FS Sync] Detected escaped newlines in file: ' + relativePath + ', fixing...')
              fixedContent = content.replace(/\\n/g, '\n')
            }
            
            const workspacePath = 'workspace/' + relativePath
            
            // Check if file is already in database
            const existsInDb = dbFiles.some((f: any) => f.path === workspacePath)
            
            console.log('Checking file: ' + workspacePath + ' - existsInDb: ' + existsInDb)
            
            // CRITICAL FIX: Always update database with file system content to fix formatting issues
            // This ensures files like schema.prisma have proper newlines
            if (existsInDb) {
              // File exists in DB - check if content has changed before updating
              const dbFile = dbFiles.find((f: any) => f.path === workspacePath)
              const contentChanged = dbFile && dbFile.content !== fixedContent
              
              if (contentChanged) {
                console.log('[FS Sync] Content changed, updating file in DB: ' + workspacePath)
                try {
                  // @ts-ignore
                  await prisma.workspaceFile.update({
                    where: {
                      projectId_path: {
                        projectId,
                        path: workspacePath
                      }
                    },
                    data: {
                      content: fixedContent,
                      updatedAt: new Date()
                    }
                  })
                } catch (updateError: any) {
                  // If update fails because record doesn't exist, create it instead
                  if (updateError.code === 'P2025') {
                    console.log('[FS Sync] Record not found for update, creating instead: ' + workspacePath)
                    // @ts-ignore
                    await prisma.workspaceFile.create({
                      data: {
                        projectId,
                        path: workspacePath,
                        content: fixedContent,
                        description: 'Auto-synced from file system'
                      }
                    })
                  } else {
                    throw updateError
                  }
                }
              }
            } else {
              // File exists on disk but not in DB - add it
              fileSystemFiles.push({
                path: workspacePath,
                content: fixedContent,
                isFromFileSystem: true
              })
              
              console.log('Adding file from FS to list: ' + workspacePath)
              
              // Debug: Log content before saving
              console.log('[FS Sync] Saving to DB - Content length: ' + fixedContent.length)
              console.log('[FS Sync] Saving to DB - Has real newlines: ' + fixedContent.includes('\n'))
              console.log('[FS Sync] Saving to DB - First 100 chars: ' + JSON.stringify(fixedContent.substring(0, 100)))
              
              // Also save to database for next time
              // @ts-ignore
              await prisma.workspaceFile.upsert({
                where: {
                  projectId_path: {
                    projectId,
                    path: workspacePath
                  }
                },
                update: {
                  content: fixedContent,
                  updatedAt: new Date()
                },
                create: {
                  projectId,
                  path: workspacePath,
                  content: fixedContent,
                  description: 'Auto-synced from file system'
                }
              })
            }
          }
        }
      }
      
      await scanDirectory(workspaceDir)
      console.log('Synced ' + fileSystemFiles.length + ' files from file system to database')
    } catch (fsError: any) {
      // Workspace directory doesn't exist yet - that's OK
      if (fsError.code !== 'ENOENT') {
        console.error('Error scanning workspace directory:', fsError)
      }
    }
    
    // Combine database files and file system files (deduplicate by path)
    console.log('[Merge] DB files: ' + dbFiles.length + ', FS files: ' + fileSystemFiles.length)
    const allFiles = [...fileSystemFiles, ...dbFiles]  // File system files take priority
    const uniqueFiles = new Map()
    
    // Deduplicate - file system files take priority over database files
    for (const file of allFiles) {
      if (!uniqueFiles.has(file.path)) {
        uniqueFiles.set(file.path, file)
      } else {
        console.log('[Dedup] Skipping duplicate file: ' + file.path)
      }
    }
    
    // Transform to FileNode format (filter out directories and only show file system files)
    const flatFiles = Array.from(uniqueFiles.values())
      .filter((file: any) => {
        // Only include actual files (must have an extension or be a known file type)
        const pathParts = file.path.split('/')
        const name = pathParts[pathParts.length - 1] || ''
        
        // Skip if it looks like a directory (no extension and not a special file)
        const hasExtension = name.includes('.')
        const isSpecialFile = ['Dockerfile', 'Makefile', 'README'].includes(name)
        
        // Only show files that actually have content (from file system sync)
        const hasContent = file.content && file.content.length > 0
        
        // Debug: Log filtering decisions
        if (!(hasExtension || isSpecialFile)) {
          console.log('[Filter] Skipping directory-like file: ' + file.path)
        } else if (!hasContent) {
          console.log('[Filter] Skipping file with no content: ' + file.path + ' (length: ' + (file.content?.length || 0) + ')')
        }
        
        return (hasExtension || isSpecialFile) && hasContent
      })
      .map((file: any) => {
        const pathParts = file.path.split('/')
        const name = pathParts[pathParts.length - 1] || file.path
        
        return {
          name,
          type: 'file' as const,
          path: file.path,
        }
      })
    
    // Build tree structure from flat file list
    const buildFileTree = (files: any[]): any[] => {
      const tree: any[] = []
      const folderMap = new Map<string, any>()
      
      // Sort files by path to ensure consistent ordering
      files.sort((a, b) => a.path.localeCompare(b.path))
      
      for (const file of files) {
        const parts = file.path.split('/')
        let currentLevel = tree
        let currentPath = ''
        
        // Build folder structure
        for (let i = 0; i < parts.length - 1; i++) {
          currentPath += (currentPath ? '/' : '') + parts[i]
          
          // Check if folder already exists
          if (!folderMap.has(currentPath)) {
            const folder = {
              name: parts[i],
              type: 'folder' as const,
              path: currentPath,
              children: []
            }
            currentLevel.push(folder)
            folderMap.set(currentPath, folder)
          }
          
          currentLevel = folderMap.get(currentPath)!.children
        }
        
        // Add file to current level
        currentLevel.push(file)
      }
      
      // CRITICAL FIX: Return only the children of the 'workspace' folder, not the workspace folder itself
      // This prevents duplicate display of files both at root and inside workspace folder
      if (tree.length === 1 && tree[0].type === 'folder' && tree[0].name === 'workspace') {
        console.log('[Tree] Unwrapping workspace folder to show only its contents')
        return tree[0].children || []
      }
      
      return tree
    }
    
    const files = buildFileTree(flatFiles)
    
    console.log('Returning ' + flatFiles.length + ' unique files (' + dbFiles.length + ' from DB, ' + fileSystemFiles.length + ' from FS) in tree structure')
    
    return NextResponse.json({ files })
  } catch (error) {
    console.error('Get workspace files error:', error)
    return NextResponse.json({ error: 'Failed to fetch files' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const projectId = await getCurrentProjectId(request)
    
    if (!projectId) {
      return NextResponse.json({ error: 'No project selected' }, { status: 400 })
    }
    
    const { files } = await request.json()
    
    // Upsert files (create or update)
    for (const file of files) {
      // @ts-ignore - Prisma client will include this after restart
      await prisma.workspaceFile.upsert({
        where: {
          projectId_path: {
            projectId,
            path: file.path
          }
        },
        update: {
          content: file.content,
          description: file.description,
        },
        create: {
          projectId,
          path: file.path,
          content: file.content,
          description: file.description,
        }
      })
    }
    
    return NextResponse.json({ 
      success: true,
      message: `${files.length} files saved to workspace` 
    })
  } catch (error) {
    console.error('Save workspace files error:', error)
    return NextResponse.json({ error: 'Failed to save files' }, { status: 500 })
  }
}

/**
 * Update a single file's content
 */
export async function PUT(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const projectId = await getCurrentProjectId(request)
    
    if (!projectId) {
      return NextResponse.json({ error: 'No project selected' }, { status: 400 })
    }
    
    const { filePath, content } = await request.json()
    
    if (!filePath || content === undefined) {
      return NextResponse.json({ error: 'filePath and content are required' }, { status: 400 })
    }
    
    // Update file content
    // @ts-ignore - Prisma client will include this after restart
    const updatedFile = await prisma.workspaceFile.update({
      where: {
        projectId_path: {
          projectId,
          path: filePath
        }
      },
      data: {
        content,
        updatedAt: new Date()
      }
    })
    
    return NextResponse.json({ 
      success: true,
      file: updatedFile,
      message: 'File saved successfully' 
    })
  } catch (error: any) {
    console.error('Update file error:', error)
    
    if (error.code === 'P2025') {
      return NextResponse.json({ error: 'File not found' }, { status: 404 })
    }
    
    return NextResponse.json({ error: 'Failed to update file' }, { status: 500 })
  }
}

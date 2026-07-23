import { prisma } from '@/lib/db'
import { promises as fs } from 'fs'
import path from 'path'
import crypto from 'crypto'
import { S3StorageService } from './s3Storage'

export interface StorageService {
  // Bucket operations
  createBucket(name: string, projectId: string, isPublic?: boolean): Promise<{ id: string; name: string; isPublic: boolean }>
  listBuckets(projectId: string): Promise<Array<{ id: string; name: string; isPublic: boolean; fileCount: number; totalSize: bigint }>>
  deleteBucket(bucketId: string, projectId: string): Promise<void>
  getBucket(bucketId: string, projectId: string): Promise<{ id: string; name: string; isPublic: boolean } | null>

  // File operations
  uploadFile(
    bucketId: string,
    file: { name: string; buffer: Buffer; mimeType?: string },
    options: { isPublic?: boolean; projectId: string; uploadedBy?: string }
  ): Promise<{ id: string; name: string; path: string; url: string; size: bigint }>
  listFiles(bucketId: string | undefined, projectId: string, options?: { limit?: number; offset?: number; search?: string }): Promise<Array<{
    id: string
    name: string
    size: bigint
    mimeType: string | null
    isPublic: boolean
    bucket: string
    createdAt: Date
    url: string
  }>>
  getFile(fileId: string, projectId: string): Promise<{ path: string; buffer: Buffer; mimeType: string | null; name: string } | null>
  getFileUrl(fileId: string, projectId: string, expiresIn?: number): Promise<string>
  deleteFile(fileId: string, projectId: string): Promise<void>
  deleteFiles(fileIds: string[], projectId: string): Promise<void>

  // Stats
  getBucketStats(bucketId: string, projectId: string): Promise<{ fileCount: number; totalSize: bigint }>
  getProjectStats(projectId: string): Promise<{ totalFiles: number; totalSize: bigint; buckets: Array<{ name: string; fileCount: number; size: bigint }> }>
}

// Local filesystem implementation
class LocalStorageService implements StorageService {
  private storageDir: string

  constructor() {
    // Use a storage directory in the project root
    this.storageDir = process.env.STORAGE_DIR || path.join(process.cwd(), 'storage')
    this.ensureStorageDir()
  }

  private async ensureStorageDir() {
    try {
      await fs.mkdir(this.storageDir, { recursive: true })
    } catch (error) {
      console.error('Failed to create storage directory:', error)
    }
  }

  private safePathSegment(value: string): string {
    const safe = value.replace(/[^a-zA-Z0-9._-]/g, '_')
    if (!safe || safe === '.' || safe === '..') {
      throw new Error('Invalid storage path segment')
    }
    return safe
  }

  private getBucketDir(projectId: string, bucketName: string): string {
    return path.join(this.storageDir, this.safePathSegment(projectId), this.safePathSegment(bucketName))
  }

  private async ensureBucketDir(projectId: string, bucketName: string) {
    const bucketDir = this.getBucketDir(projectId, bucketName)
    await fs.mkdir(bucketDir, { recursive: true })
  }

  async createBucket(name: string, projectId: string, isPublic: boolean = false) {
    if (!projectId) {
      throw new Error('Project ID is required for tenant isolation')
    }

    // Check if bucket already exists (scoped to project)
    const existing = await prisma.storageBucket.findFirst({
      where: { name, projectId },
    })

    if (existing) {
      throw new Error(`Bucket "${name}" already exists in this project`)
    }

    const bucket = await prisma.storageBucket.create({
      data: {
        name,
        projectId, // Required for tenant isolation
        isPublic,
      },
    })

    // Create physical directory
    await this.ensureBucketDir(projectId, name)

    return {
      id: bucket.id,
      name: bucket.name,
      isPublic: bucket.isPublic,
    }
  }

  async listBuckets(projectId: string) {
    if (!projectId) {
      throw new Error('Project ID is required for tenant isolation')
    }

    const buckets = await prisma.storageBucket.findMany({
      where: { projectId }, // Required - always scope to project
      include: {
        files: {
          // Soft-deleted files must not inflate the bucket's file count or
          // size — listFiles() already excludes them, so the counts shown in
          // the dashboard would otherwise disagree with the file list.
          where: { deletedAt: null },
          select: {
            size: true,
          },
        },
      },
    })

    return buckets.map((bucket) => ({
      id: bucket.id,
      name: bucket.name,
      isPublic: bucket.isPublic,
      fileCount: bucket.files.length,
      totalSize: bucket.files.reduce((sum, file) => sum + file.size, BigInt(0)), // Keep as BigInt
    }))
  }

  async deleteBucket(bucketId: string, projectId: string) {
    if (!projectId) {
      throw new Error('Project ID is required for tenant isolation')
    }

    const bucket = await prisma.storageBucket.findUnique({
      where: { id: bucketId },
      include: { files: true },
    })

    if (!bucket) {
      throw new Error('Bucket not found')
    }

    // Validate tenant ownership
    if (bucket.projectId !== projectId) {
      throw new Error('Bucket does not belong to this project')
    }

    // Delete all files first
    for (const file of bucket.files) {
      await this.deleteFile(file.id, projectId)
    }

    // Delete bucket from database
    await prisma.storageBucket.delete({
      where: { id: bucketId },
    })

    // Delete physical directory
    const bucketDir = this.getBucketDir(projectId, bucket.name)
    try {
      await fs.rmdir(bucketDir, { recursive: true })
    } catch (error) {
      console.error(`Failed to delete bucket directory ${bucketDir}:`, error)
    }
  }

  async getBucket(bucketId: string, projectId: string) {
    if (!projectId) {
      throw new Error('Project ID is required for tenant isolation')
    }

    const bucket = await prisma.storageBucket.findUnique({
      where: { id: bucketId },
    })

    if (!bucket) return null

    // Validate tenant ownership
    if (bucket.projectId !== projectId) {
      throw new Error('Bucket does not belong to this project')
    }

    return {
      id: bucket.id,
      name: bucket.name,
      isPublic: bucket.isPublic,
    }
  }

  async uploadFile(
    bucketId: string,
    file: { name: string; buffer: Buffer; mimeType?: string },
    options: { isPublic?: boolean; projectId: string; uploadedBy?: string }
  ) {
    if (!options.projectId) {
      throw new Error('Project ID is required for tenant isolation')
    }

    const bucket = await prisma.storageBucket.findUnique({
      where: { id: bucketId },
      select: {
        id: true,
        name: true,
        projectId: true,
        isPublic: true,
        accessPolicy: true,
        allowedMimeTypes: true,
        allowedExtensions: true,
        blockExecutables: true,
        maxFileSizeBytes: true,
        overwriteStrategy: true,
      },
    })

    if (!bucket) {
      throw new Error('Bucket not found')
    }

    // Validate tenant ownership
    if (bucket.projectId !== options.projectId) {
      throw new Error('Bucket does not belong to this project')
    }

    // ============ P0: MIME TYPE & EXTENSION VALIDATION (SECURITY) ============
    const fileExt = path.extname(file.name).toLowerCase()
    const detectedMimeType = file.mimeType || 'application/octet-stream'

    // Dangerous executable extensions
    const DANGEROUS_EXTENSIONS = [
      '.exe', '.bat', '.cmd', '.sh', '.bash', '.ps1', '.app', '.deb', '.rpm',
      '.msi', '.dmg', '.pkg', '.run', '.bin', '.jar', '.dll', '.so', '.dylib',
      '.scr', '.vbs', '.js', '.jse', '.wsf', '.wsh', '.com', '.pif', '.lnk'
    ]

    // Block executables if enabled
    if (bucket.blockExecutables && DANGEROUS_EXTENSIONS.includes(fileExt)) {
      throw new Error(
        `Executable files are not allowed. File extension "${fileExt}" is blocked for security.`
      )
    }

    // Validate file extension against whitelist
    if (bucket.allowedExtensions.length > 0 && !bucket.allowedExtensions.includes(fileExt)) {
      throw new Error(
        `File extension "${fileExt}" is not allowed in this bucket. ` +
        `Allowed extensions: ${bucket.allowedExtensions.join(', ')}`
      )
    }

    // Validate MIME type against whitelist
    if (bucket.allowedMimeTypes.length > 0 && !bucket.allowedMimeTypes.includes(detectedMimeType)) {
      throw new Error(
        `File type "${detectedMimeType}" is not allowed in this bucket. ` +
        `Allowed types: ${bucket.allowedMimeTypes.join(', ')}`
      )
    }

    // Cross-check: Ensure MIME type matches extension (prevent spoofing)
    const extensionMimeMap: Record<string, string[]> = {
      // Images
      '.jpg': ['image/jpeg'],
      '.jpeg': ['image/jpeg'],
      '.png': ['image/png'],
      '.gif': ['image/gif'],
      '.webp': ['image/webp'],
      '.svg': ['image/svg+xml'],
      
      // Documents
      '.pdf': ['application/pdf'],
      '.txt': ['text/plain'],
      '.csv': ['text/csv', 'application/csv'],
      
      // Videos
      '.mp4': ['video/mp4'],
      '.webm': ['video/webm'],
      '.ogv': ['video/ogg'],
      '.mov': ['video/quicktime'],
      '.avi': ['video/x-msvideo'],
      
      // Audio
      '.mp3': ['audio/mpeg'],
      '.wav': ['audio/wav', 'audio/x-wav'],
      '.ogg': ['audio/ogg'],
      '.m4a': ['audio/mp4'],
    }

    const expectedMimes = extensionMimeMap[fileExt]
    if (expectedMimes && !expectedMimes.includes(detectedMimeType)) {
      throw new Error(
        `File extension "${fileExt}" does not match MIME type "${detectedMimeType}". ` +
        `Possible file spoofing detected.`
      )
    }
    // =========================================================================

    // ============ P0: STORAGE QUOTA VALIDATION ============
    // Get project limits
    const project = await prisma.project.findUnique({
      where: { id: options.projectId },
      select: {
        storageUsed: true,
        storageLimit: true,
        maxFileSize: true,
        maxFilesPerBucket: true,
      },
    })

    if (!project) {
      throw new Error('Project not found')
    }

    const fileSize = BigInt(file.buffer.length)

    // P1: Check bucket-level file size limit (overrides project default if smaller)
    if (fileSize > bucket.maxFileSizeBytes) {
      const maxSizeMB = Number(bucket.maxFileSizeBytes) / (1024 * 1024)
      const fileSizeMB = Number(fileSize) / (1024 * 1024)
      throw new Error(
        `File size (${fileSizeMB.toFixed(2)}MB) exceeds bucket's maximum allowed size (${maxSizeMB}MB)`
      )
    }

    // Check project-level file size limit
    if (fileSize > project.maxFileSize) {
      const maxSizeMB = Number(project.maxFileSize) / (1024 * 1024)
      const fileSizeMB = Number(fileSize) / (1024 * 1024)
      throw new Error(
        `File size (${fileSizeMB.toFixed(2)}MB) exceeds maximum allowed size (${maxSizeMB}MB)`
      )
    }

    // Check total storage quota
    const newTotalSize = project.storageUsed + fileSize
    if (newTotalSize > project.storageLimit) {
      const limitGB = Number(project.storageLimit) / (1024 * 1024 * 1024)
      const usedGB = Number(project.storageUsed) / (1024 * 1024 * 1024)
      const availableGB = Number(project.storageLimit - project.storageUsed) / (1024 * 1024 * 1024)
      throw new Error(
        `Storage quota exceeded. Used: ${usedGB.toFixed(2)}GB / ${limitGB.toFixed(2)}GB. ` +
        `Available: ${availableGB.toFixed(2)}GB. Please upgrade your plan or delete unused files.`
      )
    }

    // Check files per bucket limit (only count active files, not soft-deleted)
    const filesInBucket = await prisma.storageFile.count({
      where: { 
        bucketId,
        deletedAt: null, // Only count active files
      },
    })

    if (filesInBucket >= project.maxFilesPerBucket) {
      throw new Error(
        `Bucket has reached maximum file limit (${project.maxFilesPerBucket} files). ` +
        `Please delete unused files or create a new bucket.`
      )
    }
    // ======================================================

    // ============ P1: OVERWRITE STRATEGY HANDLING ============
    // Check if file with same name already exists (active files only)
    const existingFile = await prisma.storageFile.findFirst({
      where: {
        bucketId,
        name: file.name,
        deletedAt: null, // Ignore soft-deleted files
      },
    })

    let finalFileName = file.name
    let version = 1
    const originalName = file.name

    if (existingFile) {
      const strategy = bucket.overwriteStrategy

      switch (strategy) {
        case 'deny':
          throw new Error(
            `File "${file.name}" already exists in this bucket. ` +
            `Overwriting is not allowed. Please rename your file or delete the existing one.`
          )

        case 'replace':
          // Soft delete the existing file (we'll handle this in transaction)
          break

        case 'version': {
          // Increment version number
          version = existingFile.version + 1
          const ext = path.extname(file.name)
          const baseName = path.basename(file.name, ext)
          finalFileName = `${baseName}_v${version}${ext}`
          break
        }

        case 'auto_rename':
        default: {
          // Auto-rename with counter
          const ext = path.extname(file.name)
          const baseName = path.basename(file.name, ext)
          let counter = 1
          
          // Find next available name
          while (true) {
            const candidateName = `${baseName}_${counter}${ext}`
            const exists = await prisma.storageFile.findFirst({
              where: {
                bucketId,
                name: candidateName,
                deletedAt: null,
              },
            })
            
            if (!exists) {
              finalFileName = candidateName
              break
            }
            counter++
          }
          break
        }
      }
    }
    // =========================================================

    // Generate unique storage path (always unique for physical storage)
    const ext = path.extname(finalFileName)
    const baseName = path.basename(finalFileName, ext)
    const uniqueName = `${baseName}-${crypto.randomBytes(8).toString('hex')}${ext}`
    const filePath = path.join(this.getBucketDir(options.projectId, bucket.name), uniqueName)

    // Ensure bucket directory exists
    await this.ensureBucketDir(options.projectId, bucket.name)

    // Write file to disk
    await fs.writeFile(filePath, file.buffer)

    // Create database record and update project storage usage
    const storageFile = await prisma.$transaction(async (tx) => {
      // If strategy is 'replace', soft delete the existing file
      if (existingFile && bucket.overwriteStrategy === 'replace') {
        await tx.storageFile.update({
          where: { id: existingFile.id },
          data: {
            deletedAt: new Date(),
            deletedBy: options?.uploadedBy || null,
          },
        })

        // Decrement project storage usage for replaced file
        await tx.project.update({
          where: { id: options.projectId },
          data: {
            storageUsed: {
              decrement: existingFile.size,
            },
          },
        })
      }

      // Derive isPublic from bucket access policy (#74)
      const accessPolicy = (bucket as any).accessPolicy as string | undefined
      const isPublicFile =
        options?.isPublic ??
        (accessPolicy === 'public_read' || accessPolicy === 'cdn_cacheable' || bucket.isPublic)

      // Create file record
      const storageFile = await tx.storageFile.create({
        data: {
          bucketId,
          name: finalFileName,
          originalName,
          version,
          path: filePath,
          size: BigInt(file.buffer.length),
          mimeType: file.mimeType || null,
          isPublic: isPublicFile,
          projectId: options.projectId, // Required - use validated projectId
          uploadedBy: options?.uploadedBy || null,
          processingStatus: 'pending', // Will be updated by storageProcessing hook (#77)
        },
      })

      // Update project storage used counter
      await tx.project.update({
        where: { id: options.projectId },
        data: {
          storageUsed: {
            increment: BigInt(file.buffer.length),
          },
        },
      })

      return storageFile
    })

    // Trigger post-upload file processing (#77) — non-blocking, runs in background
    if (file.mimeType) {
      import('@/lib/services/storageProcessing').then(({ scheduleFileProcessing }) => {
        scheduleFileProcessing(storageFile.id, filePath, file.mimeType!)
      }).catch(() => {})
    }

    // Local driver: the canonical URL is always the local download endpoint,
    // keyed by file id — identical to what listFiles() / getFileUrl() emit and
    // what /api/storage/files/{id}/download resolves.
    //
    // We deliberately do NOT route through cdnService here: on the local driver
    // its fallback produced a *fileName*-keyed URL, which the download route
    // (which matches by id) could never resolve — every file was undownloadable
    // immediately after upload. cdnService stays the URL source for the S3
    // driver only.
    const baseUrl = process.env.STORAGE_BASE_URL || '/api/storage/files'
    const url = storageFile.isPublic
      ? `${baseUrl}/${storageFile.id}/download`
      : `${baseUrl}/${storageFile.id}/download?token=${await this.generateAccessToken(storageFile.id)}`

    return {
      id: storageFile.id,
      name: storageFile.name,
      path: storageFile.path,
      url,
      size: storageFile.size,
    }
  }

  async listFiles(bucketId: string | undefined, projectId: string, options?: { limit?: number; offset?: number; search?: string }) {
    if (!projectId) {
      throw new Error('Project ID is required for tenant isolation')
    }

    const where: any = {
      projectId, // Required - always scope to project
      deletedAt: null, // P1: Only show active files (not soft-deleted)
    }
    if (bucketId) where.bucketId = bucketId
    if (options?.search) {
      where.name = { contains: options.search, mode: 'insensitive' }
    }

    const files = await prisma.storageFile.findMany({
      where,
      include: {
        bucket: {
          select: {
            name: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: options?.limit || 100,
      skip: options?.offset || 0,
    })

    const baseUrl = process.env.STORAGE_BASE_URL || '/api/storage/files'

    return files.map((file) => ({
      id: file.id,
      name: file.name,
      size: file.size, // Keep as BigInt
      mimeType: file.mimeType,
      isPublic: file.isPublic,
      bucket: file.bucket.name,
      createdAt: file.createdAt,
      url: file.isPublic
        ? `${baseUrl}/${file.id}/download`
        : `${baseUrl}/${file.id}/download?token=${this.generateAccessTokenSync(file.id)}`,
    }))
  }

  async getFile(fileId: string, projectId: string) {
    if (!projectId) {
      throw new Error('Project ID is required for tenant isolation')
    }

    const file = await prisma.storageFile.findUnique({
      where: { id: fileId },
    })

    if (!file) return null

    // P1: Check if file is soft-deleted
    if (file.deletedAt) {
      return null // Treat soft-deleted files as not found
    }

    // Validate tenant ownership
    if (file.projectId !== projectId) {
      throw new Error('File does not belong to this project')
    }

    try {
      const buffer = await fs.readFile(file.path)
      return {
        path: file.path,
        buffer,
        mimeType: file.mimeType,
        name: file.name,
      }
    } catch (error) {
      console.error(`Failed to read file ${file.path}:`, error)
      return null
    }
  }

  async getFileUrl(fileId: string, projectId: string, expiresIn?: number): Promise<string> {
    if (!projectId) {
      throw new Error('Project ID is required for tenant isolation')
    }

    const file = await prisma.storageFile.findUnique({
      where: { id: fileId },
    })

    if (!file) {
      throw new Error('File not found')
    }

    // P1: Check if file is soft-deleted
    if (file.deletedAt) {
      throw new Error('File not found') // Treat soft-deleted files as not found
    }

    // Validate tenant ownership
    if (file.projectId !== projectId) {
      throw new Error('File does not belong to this project')
    }

    const baseUrl = process.env.STORAGE_BASE_URL || '/api/storage/files'
    if (file.isPublic) {
      return `${baseUrl}/${fileId}/download`
    }

    // For private files, generate a signed URL
    const token = await this.generateAccessToken(fileId, expiresIn)
    return `${baseUrl}/${fileId}/download?token=${token}`
  }

  async deleteFile(fileId: string, projectId: string, deletedBy?: string) {
    if (!projectId) {
      throw new Error('Project ID is required for tenant isolation')
    }

    const file = await prisma.storageFile.findUnique({
      where: { id: fileId },
    })

    if (!file) {
      throw new Error('File not found')
    }

    // Validate tenant ownership
    if (file.projectId !== projectId) {
      throw new Error('File does not belong to this project')
    }

    // P1: SOFT DELETE - Mark as deleted instead of removing immediately
    await prisma.$transaction(async (tx) => {
      // Update file record with soft delete timestamp
      await tx.storageFile.update({
        where: { id: fileId },
        data: {
          deletedAt: new Date(),
          deletedBy: deletedBy || null,
        },
      })

      // Decrement project storage usage (freed up for new uploads)
      await tx.project.update({
        where: { id: projectId },
        data: {
          storageUsed: {
            decrement: file.size,
          },
        },
      })
    })

    // Note: Physical file deletion happens via background cleanup job
    // Files stay on disk for X days (configurable) for safety/recovery
  }

  async deleteFiles(fileIds: string[], projectId: string) {
    if (!projectId) {
      throw new Error('Project ID is required for tenant isolation')
    }

    await Promise.all(fileIds.map((id) => this.deleteFile(id, projectId)))
  }

  async getBucketStats(bucketId: string, projectId: string) {
    if (!projectId) {
      throw new Error('Project ID is required for tenant isolation')
    }

    // First validate bucket belongs to project
    const bucket = await prisma.storageBucket.findUnique({
      where: { id: bucketId },
      select: { projectId: true },
    })

    if (!bucket) {
      throw new Error('Bucket not found')
    }

    if (bucket.projectId !== projectId) {
      throw new Error('Bucket does not belong to this project')
    }

    const files = await prisma.storageFile.findMany({
      where: { bucketId, projectId, deletedAt: null }, // Scope to project, active only
      select: { size: true },
    })

    return {
      fileCount: files.length,
      totalSize: files.reduce((sum, file) => sum + file.size, BigInt(0)), // Keep as BigInt
    }
  }

  async getProjectStats(projectId: string) {
    if (!projectId) {
      throw new Error('Project ID is required for tenant isolation')
    }

    const where = { projectId } // Required - always scope to project

    const [files, buckets] = await Promise.all([
      prisma.storageFile.findMany({
        // Active files only — soft-deleted files no longer count toward usage
        // (project.storageUsed is decremented on delete, so including them here
        // made the dashboard's "storage used" disagree with the real counter).
        where: { projectId, deletedAt: null },
        select: {
          size: true,
          bucketId: true,
          bucket: {
            select: { name: true },
          },
        },
      }),
      prisma.storageBucket.findMany({
        where,
        include: {
          files: {
            where: { deletedAt: null },
            select: { size: true },
          },
        },
      }),
    ])

    const totalSize = files.reduce((sum, file) => sum + file.size, BigInt(0))

    const bucketStats = buckets.map((bucket) => ({
      name: bucket.name,
      fileCount: bucket.files.length,
      size: bucket.files.reduce((sum, file) => sum + file.size, BigInt(0)),
    }))

    return {
      totalFiles: files.length,
      totalSize, // Keep as BigInt
      buckets: bucketStats, // Keep sizes as BigInt
    }
  }

  private async generateAccessToken(fileId: string, expiresIn?: number): Promise<string> {
    // Simple token generation (in production, use JWT or similar)
    const secret = process.env.STORAGE_SECRET || 'default-secret-change-in-production'
    const expires = expiresIn ? Date.now() + expiresIn * 1000 : Date.now() + 3600000 // 1 hour default
    const data = `${fileId}:${expires}`
    const token = crypto.createHmac('sha256', secret).update(data).digest('hex')
    return `${expires}:${token}`
  }

  private generateAccessTokenSync(fileId: string, expiresIn?: number): string {
    const secret = process.env.STORAGE_SECRET || 'default-secret-change-in-production'
    const expires = expiresIn ? Date.now() + expiresIn * 1000 : Date.now() + 3600000
    const data = `${fileId}:${expires}`
    const token = crypto.createHmac('sha256', secret).update(data).digest('hex')
    return `${expires}:${token}`
  }

  // ============ P1: PERMANENT DELETE & CLEANUP METHODS ============
  
  /**
   * Permanently delete a file (physical + database)
   * Use this for admin cleanup or background jobs only
   */
  async permanentlyDeleteFile(fileId: string, projectId: string) {
    if (!projectId) {
      throw new Error('Project ID is required for tenant isolation')
    }

    const file = await prisma.storageFile.findUnique({
      where: { id: fileId },
    })

    if (!file) {
      throw new Error('File not found')
    }

    // Validate tenant ownership
    if (file.projectId !== projectId) {
      throw new Error('File does not belong to this project')
    }

    // Delete physical file from disk
    try {
      await fs.unlink(file.path)
    } catch (error) {
      console.error(`Failed to delete physical file ${file.path}:`, error)
      // Continue with database deletion even if file is missing
    }

    // Delete database record (no storage counter update if already soft-deleted)
    await prisma.storageFile.delete({
      where: { id: fileId },
    })
  }

  /**
   * Background cleanup job: Permanently delete soft-deleted files older than X days
   * Call this from a cron job or scheduled task
   */
  async cleanupDeletedFiles(daysOld: number = 30) {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - daysOld)

    console.log(`[Storage Cleanup] Looking for soft-deleted files older than ${daysOld} days (before ${cutoffDate.toISOString()})...`)

    // Find soft-deleted files older than cutoff date
    const filesToDelete = await prisma.storageFile.findMany({
      where: {
        deletedAt: {
          not: null,
          lt: cutoffDate,
        },
      },
      select: {
        id: true,
        path: true,
        projectId: true,
        name: true,
        deletedAt: true,
      },
    })

    console.log(`[Storage Cleanup] Found ${filesToDelete.length} files to permanently delete`)

    let successCount = 0
    let errorCount = 0

    for (const file of filesToDelete) {
      try {
        // Delete physical file
        try {
          await fs.unlink(file.path)
        } catch (error) {
          console.warn(`[Storage Cleanup] Physical file already deleted: ${file.path}`)
        }

        // Delete database record
        await prisma.storageFile.delete({
          where: { id: file.id },
        })

        successCount++
        console.log(`[Storage Cleanup] Permanently deleted: ${file.name} (deleted on ${file.deletedAt?.toISOString()})`)
      } catch (error) {
        errorCount++
        console.error(`[Storage Cleanup] Failed to delete file ${file.id}:`, error)
      }
    }

    console.log(`[Storage Cleanup] Complete. Success: ${successCount}, Errors: ${errorCount}`)

    return {
      totalProcessed: filesToDelete.length,
      successCount,
      errorCount,
    }
  }

  /**
   * Restore a soft-deleted file
   * Useful for "undo delete" feature
   */
  async restoreFile(fileId: string, projectId: string) {
    if (!projectId) {
      throw new Error('Project ID is required for tenant isolation')
    }

    const file = await prisma.storageFile.findUnique({
      where: { id: fileId },
    })

    if (!file) {
      throw new Error('File not found')
    }

    if (!file.deletedAt) {
      throw new Error('File is not deleted')
    }

    // Validate tenant ownership
    if (file.projectId !== projectId) {
      throw new Error('File does not belong to this project')
    }

    // Restore file and increment storage counter
    await prisma.$transaction(async (tx) => {
      await tx.storageFile.update({
        where: { id: fileId },
        data: {
          deletedAt: null,
          deletedBy: null,
        },
      })

      // Re-add to project storage usage
      await tx.project.update({
        where: { id: projectId },
        data: {
          storageUsed: {
            increment: file.size,
          },
        },
      })
    })

    return { success: true }
  }
  // ================================================================
}

// ============================================================================
// STORAGE DRIVER CONFIGURATION
// ============================================================================

/**
 * Initialize storage service based on STORAGE_DRIVER environment variable
 * 
 * Supported drivers:
 *   - 'local' (default): LocalStorageService - stores files on server disk
 *   - 's3': S3StorageService - stores files in S3-compatible object storage
 * 
 * For S3, also set:
 *   - STORAGE_S3_ENDPOINT
 *   - STORAGE_S3_REGION
 *   - STORAGE_S3_BUCKET
 *   - STORAGE_S3_ACCESS_KEY
 *   - STORAGE_S3_SECRET_KEY
 *   - STORAGE_S3_PUBLIC_URL (optional)
 */
function initializeStorageService(): StorageService {
  const driver = process.env.STORAGE_DRIVER || 'local'

  console.log(`[Storage] Initializing storage driver: ${driver}`)

  switch (driver) {
    case 's3': {
      return new S3StorageService()
    }

    case 'local':
    default:
      return new LocalStorageService()
  }
}

// Export singleton instance
export const storageService: StorageService = initializeStorageService()

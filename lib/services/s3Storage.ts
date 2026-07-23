/**
 * S3-Compatible Storage Service
 * 
 * Production-grade storage implementation using S3-compatible object storage.
 * Works with: AWS S3, Cloudflare R2, MinIO, Backblaze B2, Google Cloud Storage (S3 compat mode)
 * 
 * Environment Variables:
 *   STORAGE_S3_ENDPOINT - S3 endpoint URL (e.g., https://s3.amazonaws.com or https://<account-id>.r2.cloudflarestorage.com)
 *   STORAGE_S3_REGION - Region (e.g., us-east-1, auto for R2/MinIO)
 *   STORAGE_S3_BUCKET - Bucket name
 *   STORAGE_S3_ACCESS_KEY - Access key ID
 *   STORAGE_S3_SECRET_KEY - Secret access key
 *   STORAGE_S3_PUBLIC_URL - Optional: Public CDN URL for public files
 */

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { prisma } from '@/lib/db'
import crypto from 'crypto'
import type { StorageService } from './storage'
import { generateUniqueStoragePath, enforceStorageQuota as enforceStorageLifecycleQuota, generatePresignedUrlExpiry } from '@/lib/storage/storage-lifecycle'
import { enforceStorageQuota as enforceStorageBillingQuota } from './quota-enforcement'
import { getS3Client, getS3Config } from './s3-config'

export class S3StorageService implements StorageService {
  private s3Client: S3Client
  private bucket: string
  private publicUrl?: string

  constructor() {
    // Single source of truth for S3 config (see lib/services/s3-config.ts).
    // Region is derived from the endpoint so a mis-set STORAGE_S3_REGION can
    // never break Backblaze/AWS signing again.
    const cfg = getS3Config()
    this.bucket = cfg.bucket
    this.publicUrl = cfg.publicUrl

    if (!cfg.endpoint || !cfg.accessKeyId || !cfg.secretAccessKey || !cfg.bucket) {
      throw new Error(
        'S3 storage requires: STORAGE_S3_ENDPOINT, STORAGE_S3_ACCESS_KEY, ' +
        'STORAGE_S3_SECRET_KEY, STORAGE_S3_BUCKET environment variables'
      )
    }

    this.s3Client = getS3Client()

    console.log(
      `[S3Storage] Initialized with endpoint: ${cfg.endpoint}, bucket: ${this.bucket}, region: ${cfg.region}`
    )
  }

  /**
   * The base URL of a genuine public CDN/host for direct object access, or null.
   *
   * Returns null when the only configured "public URL" is the S3 API endpoint
   * itself — because our shared bucket is private, so that host can't serve
   * objects without a presigned signature (it 401s). Set STORAGE_CDN_URL (or
   * point STORAGE_S3_PUBLIC_URL at a real public host / CDN in front of B2) to
   * enable direct public URLs.
   */
  private publicCdnBase(): string | null {
    const base = process.env.STORAGE_CDN_URL || this.publicUrl
    if (!base) return null
    try {
      const baseHost = new URL(base).host
      const endpoint = getS3Config().endpoint
      const epHost = endpoint ? new URL(endpoint).host : ''
      if (baseHost && baseHost === epHost) return null // raw S3 endpoint, not a CDN
    } catch {
      return null
    }
    return base.replace(/\/$/, '')
  }

  /**
   * Generate S3 object key (path) for a file
   * Format: {projectId}/{bucketId}/{fileId}-{randomHash}.ext
   */
  private generateS3Key(projectId: string, bucketId: string, fileName: string): string {
    const fileId = crypto.randomUUID()
    const ext = fileName.includes('.') ? fileName.substring(fileName.lastIndexOf('.')) : ''
    const hash = crypto.randomBytes(8).toString('hex')
    return `${projectId}/${bucketId}/${fileId}-${hash}${ext}`
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
        projectId,
        isPublic,
      },
    })

    // Note: We don't create physical S3 buckets per user bucket
    // All files go into one S3 bucket with projectId/bucketId prefixes
    console.log(`[S3Storage] Created logical bucket: ${name} (projectId: ${projectId})`)

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
      where: { projectId },
      include: {
        files: {
          where: { deletedAt: null }, // Only count active files
          select: { size: true },
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
      include: { files: { where: { deletedAt: null } } },
    })

    if (!bucket) {
      throw new Error('Bucket not found')
    }

    if (bucket.projectId !== projectId) {
      throw new Error('Bucket does not belong to this project')
    }

    // Delete all active files first
    for (const file of bucket.files) {
      await this.deleteFile(file.id, projectId)
    }

    // Delete bucket from database
    await prisma.storageBucket.delete({
      where: { id: bucketId },
    })

    console.log(`[S3Storage] Deleted bucket: ${bucket.name}`)
  }

  async getBucket(bucketId: string, projectId: string) {
    if (!projectId) {
      throw new Error('Project ID is required for tenant isolation')
    }

    const bucket = await prisma.storageBucket.findUnique({
      where: { id: bucketId },
    })

    if (!bucket) return null

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

    if (bucket.projectId !== options.projectId) {
      throw new Error('Bucket does not belong to this project')
    }

    // ============ SECURITY VALIDATIONS (same as LocalStorageService) ============
    const fileExt = file.name.includes('.') ? file.name.substring(file.name.lastIndexOf('.')).toLowerCase() : ''
    const detectedMimeType = file.mimeType || 'application/octet-stream'

    const DANGEROUS_EXTENSIONS = [
      '.exe', '.bat', '.cmd', '.sh', '.bash', '.ps1', '.app', '.deb', '.rpm',
      '.msi', '.dmg', '.pkg', '.run', '.bin', '.jar', '.dll', '.so', '.dylib',
      '.scr', '.vbs', '.js', '.jse', '.wsf', '.wsh', '.com', '.pif', '.lnk'
    ]

    if (bucket.blockExecutables && DANGEROUS_EXTENSIONS.includes(fileExt)) {
      throw new Error(
        `Executable files are not allowed. File extension "${fileExt}" is blocked for security.`
      )
    }

    if (bucket.allowedExtensions.length > 0 && !bucket.allowedExtensions.includes(fileExt)) {
      throw new Error(
        `File extension "${fileExt}" is not allowed in this bucket. ` +
        `Allowed extensions: ${bucket.allowedExtensions.join(', ')}`
      )
    }

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

    // Get project quotas
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

    // ============ HARDENED QUOTA ENFORCEMENT ============
    // AUTOMATIC: No bypass, no grace period, no overrides
    const quotaCheck = await enforceStorageLifecycleQuota(
      options.projectId,
      fileSize
    )
    
    if (!quotaCheck.allowed) {
      throw new Error(quotaCheck.reason || 'Storage quota exceeded')
    }

    // ============ BILLING QUOTA ENFORCEMENT ============
    // Block if user exceeded subscription storage limit
    await enforceStorageBillingQuota(options.projectId, Number(fileSize))

    // Check bucket-level file size limit
    if (fileSize > bucket.maxFileSizeBytes) {
      const maxSizeMB = Number(bucket.maxFileSizeBytes) / (1024 * 1024)
      const fileSizeMB = Number(fileSize) / (1024 * 1024)
      throw new Error(
        `File size (${fileSizeMB.toFixed(2)}MB) exceeds bucket's maximum allowed size (${maxSizeMB}MB)`
      )
    }

    // ============ OVERWRITE STRATEGY HANDLING ============
    const existingFile = await prisma.storageFile.findFirst({
      where: {
        bucketId,
        name: file.name,
        deletedAt: null,
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
          // Soft delete the existing file (handled in transaction below)
          break

        case 'version':
          version = existingFile.version + 1
          const ext = fileExt
          const baseName = file.name.substring(0, file.name.length - ext.length)
          finalFileName = `${baseName}_v${version}${ext}`
          break

        case 'auto_rename':
        default:
          const baseNameAuto = file.name.substring(0, file.name.length - fileExt.length)
          let counter = 1
          
          while (true) {
            const candidateName = `${baseNameAuto}_${counter}${fileExt}`
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

    // ============ CRYPTOGRAPHICALLY UNIQUE STORAGE PATH ============
    // GUARANTEE: No collisions, namespace isolation, traceable
    const { path: s3Key, fileId } = generateUniqueStoragePath(
      options.projectId,
      bucketId,
      finalFileName
    )

    // Upload to S3
    try {
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: s3Key,
          Body: file.buffer,
          ContentType: detectedMimeType,
          Metadata: {
            projectId: options.projectId,
            bucketId: bucketId,
            originalName: file.name,
            uploadedBy: options.uploadedBy || 'unknown',
          },
        })
      )
    } catch (error) {
      console.error('[S3Storage] Upload failed:', error)
      throw new Error(`Failed to upload file to S3: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }

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

        await tx.project.update({
          where: { id: options.projectId },
          data: {
            storageUsed: {
              decrement: existingFile.size,
            },
          },
        })
      }

      const newFile = await tx.storageFile.create({
        data: {
          bucketId,
          name: finalFileName,
          originalName,
          version,
          path: s3Key, // S3 key is stored as path
          size: BigInt(file.buffer.length),
          mimeType: detectedMimeType || null,
          isPublic: options?.isPublic ?? bucket.isPublic,
          projectId: options.projectId,
          uploadedBy: options?.uploadedBy || null,
        },
      })

      await tx.project.update({
        where: { id: options.projectId },
        data: {
          storageUsed: {
            increment: BigInt(file.buffer.length),
          },
        },
      })

      return newFile
    })

    // Generate URL
    const url = await this.getFileUrl(storageFile.id, options.projectId, 3600)

    console.log(`[S3Storage] Uploaded: ${finalFileName} (${fileSize} bytes) to ${s3Key}`)

    return {
      id: storageFile.id,
      name: storageFile.name,
      path: storageFile.path,
      url,
      size: storageFile.size, // Keep as BigInt
    }
  }

  async listFiles(bucketId: string | undefined, projectId: string, options?: { limit?: number; offset?: number; search?: string }) {
    if (!projectId) {
      throw new Error('Project ID is required for tenant isolation')
    }

    const where: any = {
      projectId,
      deletedAt: null,
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

    return Promise.all(
      files.map(async (file) => ({
        id: file.id,
        name: file.name,
        size: file.size, // Keep as BigInt
        mimeType: file.mimeType,
        isPublic: file.isPublic,
        bucket: file.bucket.name,
        createdAt: file.createdAt,
        url: await this.getFileUrl(file.id, projectId, 3600),
      }))
    )
  }

  async getFile(fileId: string, projectId: string) {
    if (!projectId) {
      throw new Error('Project ID is required for tenant isolation')
    }

    const file = await prisma.storageFile.findUnique({
      where: { id: fileId },
    })

    if (!file || file.deletedAt) return null

    if (file.projectId !== projectId) {
      throw new Error('File does not belong to this project')
    }

    try {
      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: file.path,
        })
      )

      const buffer = await this.streamToBuffer(response.Body as any)

      return {
        path: file.path,
        buffer,
        mimeType: file.mimeType,
        name: file.name,
      }
    } catch (error) {
      console.error(`[S3Storage] Failed to get file ${file.path}:`, error)
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

    if (!file || file.deletedAt) {
      throw new Error('File not found')
    }

    if (file.projectId !== projectId) {
      throw new Error('File does not belong to this project')
    }

    // ── Public files ─────────────────────────────────────────────────────────
    // A public file needs a permanent, auth-free URL. We must NOT hand out a raw
    // S3-endpoint URL: the shared bucket is PRIVATE (per-object presigned
    // access), so a direct `{endpoint}/{bucket}/{key}` URL returns 401. Only a
    // genuine CDN/public host (different from the S3 API endpoint) can serve the
    // object directly.
    if (file.isPublic) {
      const cdnBase = this.publicCdnBase()
      if (cdnBase) {
        return `${cdnBase}/${file.path}`
      }
      // No real CDN → serve through the app's stable public download route
      // (auth-free for public files, never expires — same shape the local
      // driver uses, so public URLs are identical across drivers).
      const appUrl = (process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/$/, '')
      if (appUrl) {
        return `${appUrl}/api/storage/files/${fileId}/download`
      }
      // Last resort (no app URL configured): fall through to a presigned URL.
    }

    // ============ PRESIGNED URLs ONLY (HARDENED) ============
    // ENFORCED: Time-limited URLs, no direct access
    // Maximum 24-hour expiry enforced
    const safeExpiry = generatePresignedUrlExpiry(expiresIn)
    
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: file.path,
    })

    const url = await getSignedUrl(this.s3Client, command, {
      expiresIn: safeExpiry,
    })

    return url
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

    if (file.projectId !== projectId) {
      throw new Error('File does not belong to this project')
    }

    // Soft delete
    await prisma.$transaction(async (tx) => {
      await tx.storageFile.update({
        where: { id: fileId },
        data: {
          deletedAt: new Date(),
          deletedBy: deletedBy || null,
        },
      })

      await tx.project.update({
        where: { id: projectId },
        data: {
          storageUsed: {
            decrement: file.size,
          },
        },
      })
    })

    console.log(`[S3Storage] Soft deleted: ${file.name} (S3 key: ${file.path})`)
    // Note: Physical S3 deletion happens via cleanup job
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
      where: { 
        bucketId,
        deletedAt: null,
      },
      select: { size: true },
    })

    return {
      fileCount: files.length,
      totalSize: files.reduce((sum, file) => sum + file.size, BigInt(0)),
    }
  }

  async getProjectStats(projectId: string) {
    if (!projectId) {
      throw new Error('Project ID is required for tenant isolation')
    }

    const where = { projectId, deletedAt: null }

    const [files, buckets] = await Promise.all([
      prisma.storageFile.findMany({
        where,
        select: {
          size: true,
          bucketId: true,
          bucket: {
            select: { name: true },
          },
        },
      }),
      prisma.storageBucket.findMany({
        where: { projectId },
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

  /**
   * Permanently delete a file from S3 and database
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

    if (file.projectId !== projectId) {
      throw new Error('File does not belong to this project')
    }

    // Delete from S3
    try {
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: file.path,
        })
      )
      console.log(`[S3Storage] Permanently deleted from S3: ${file.path}`)
    } catch (error) {
      console.error(`[S3Storage] Failed to delete from S3: ${file.path}`, error)
    }

    // Delete database record
    await prisma.storageFile.delete({
      where: { id: fileId },
    })
  }

  /**
   * Background cleanup job: Permanently delete soft-deleted files older than X days
   */
  async cleanupDeletedFiles(daysOld: number = 30) {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - daysOld)

    console.log(`[S3Storage Cleanup] Looking for soft-deleted files older than ${daysOld} days...`)

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

    console.log(`[S3Storage Cleanup] Found ${filesToDelete.length} files to permanently delete`)

    let successCount = 0
    let errorCount = 0

    for (const file of filesToDelete) {
      try {
        await this.s3Client.send(
          new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: file.path,
          })
        )

        await prisma.storageFile.delete({
          where: { id: file.id },
        })

        successCount++
        console.log(`[S3Storage Cleanup] Permanently deleted: ${file.name}`)
      } catch (error) {
        errorCount++
        console.error(`[S3Storage Cleanup] Failed to delete file ${file.id}:`, error)
      }
    }

    console.log(`[S3Storage Cleanup] Complete. Success: ${successCount}, Errors: ${errorCount}`)

    return {
      totalProcessed: filesToDelete.length,
      successCount,
      errorCount,
    }
  }

  /**
   * Restore a soft-deleted file
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

    if (file.projectId !== projectId) {
      throw new Error('File does not belong to this project')
    }

    await prisma.$transaction(async (tx) => {
      await tx.storageFile.update({
        where: { id: fileId },
        data: {
          deletedAt: null,
          deletedBy: null,
        },
      })

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

  // Helper: Convert stream to buffer
  private async streamToBuffer(stream: any): Promise<Buffer> {
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }
}

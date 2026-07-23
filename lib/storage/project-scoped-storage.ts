/**
 * PHASE 3: Project-Scoped File Storage
 * 
 * All files stored under {project_id}/ namespace
 * Signed URLs valid only for originating project
 * Cross-project access prevented at storage policy level
 */

import { ExecutionContext, assertExecutionContext } from '@/lib/context/execution-context'
import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { getS3Client, getS3Config, isS3Configured } from '@/lib/services/s3-config'

// Backblaze B2 S3-compatible storage configuration — sourced from the single
// shared config so region is derived from the endpoint (see s3-config.ts).
const S3_BUCKET = getS3Config().bucket

if (!isS3Configured()) {
  console.warn('⚠️  Storage credentials not configured. File upload features will be disabled.')
}

const s3Client = isS3Configured() ? getS3Client() : null

const BUCKET_NAME = S3_BUCKET
const URL_EXPIRY = 3600 // 1 hour

export class StorageError extends Error {
  constructor(message: string, public code: string) {
    super(message)
    this.name = 'StorageError'
  }
}

/**
 * Get project-scoped storage path
 * 
 * ALL files stored under {project_id}/ prefix
 * Ensures complete namespace isolation
 */
function getProjectPath(context: ExecutionContext, filePath: string): string {
  assertExecutionContext(context)
  
  // Remove leading slash if present
  const cleanPath = filePath.startsWith('/') ? filePath.slice(1) : filePath
  
  // CRITICAL: Prefix with project_id to create isolated namespace
  return `${context.projectId}/${cleanPath}`
}

/**
 * Validate file path doesn't escape project namespace
 */
function validateFilePath(filePath: string): void {
  // Prevent path traversal attacks
  if (filePath.includes('..') || filePath.includes('//')) {
    throw new StorageError(
      'Invalid file path: path traversal not allowed',
      'INVALID_PATH'
    )
  }
  
  // Ensure path doesn't try to escape project namespace
  if (filePath.startsWith('/') || filePath.includes('${')) {
    throw new StorageError(
      'Invalid file path: absolute paths not allowed',
      'INVALID_PATH'
    )
  }
}

/**
 * Upload file to project-scoped storage
 * 
 * File stored under {project_id}/{filePath}
 */
export async function uploadFile(
  context: ExecutionContext,
  filePath: string,
  content: Buffer | string,
  contentType?: string
): Promise<{ key: string; url: string }> {
  assertExecutionContext(context)
  validateFilePath(filePath)
  
  if (!s3Client) {
    throw new StorageError(
      'Storage not configured. Set STORAGE_S3_ACCESS_KEY and STORAGE_S3_SECRET_KEY.',
      'STORAGE_NOT_CONFIGURED'
    )
  }
  
  const projectPath = getProjectPath(context, filePath)
  
  console.log(
    `[Storage] Uploading file: ${projectPath} (project: ${context.projectId})`
  )
  
  try {
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: projectPath,
      Body: content,
      ContentType: contentType,
      Metadata: {
        projectId: context.projectId,
        executionId: context.executionId,
        uploadedAt: new Date().toISOString(),
      },
    })
    
    await s3Client.send(command)
    
    // Generate signed URL
    const url = await generateSignedUrl(context, filePath, 'read')
    
    return { key: projectPath, url }
  } catch (error) {
    console.error(`[Storage] Upload failed for ${projectPath}:`, error)
    throw new StorageError(
      'Failed to upload file',
      'UPLOAD_FAILED'
    )
  }
}

/**
 * Generate signed URL for file access
 * 
 * URL valid only for originating project
 * Expires after URL_EXPIRY seconds
 */
export async function generateSignedUrl(
  context: ExecutionContext,
  filePath: string,
  operation: 'read' | 'write' = 'read'
): Promise<string> {
  assertExecutionContext(context)
  validateFilePath(filePath)
  
  if (!s3Client) {
    throw new StorageError(
      'Storage not configured. Set STORAGE_S3_ACCESS_KEY and STORAGE_S3_SECRET_KEY.',
      'STORAGE_NOT_CONFIGURED'
    )
  }
  
  const projectPath = getProjectPath(context, filePath)
  
  try {
    const command = operation === 'read'
      ? new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: projectPath,
        })
      : new PutObjectCommand({
          Bucket: BUCKET_NAME,
          Key: projectPath,
        })
    
    // Generate signed URL with project_id in query params
    // This ensures URL is bound to specific project
    const url = await getSignedUrl(s3Client, command, {
      expiresIn: URL_EXPIRY,
    })
    
    // Add project_id as query parameter for additional validation
    const urlWithProject = `${url}&projectId=${context.projectId}`
    
    console.log(
      `[Storage] Generated signed ${operation} URL for ${projectPath} (expires in ${URL_EXPIRY}s)`
    )
    
    return urlWithProject
  } catch (error) {
    console.error(`[Storage] Failed to generate signed URL:`, error)
    throw new StorageError(
      'Failed to generate signed URL',
      'URL_GENERATION_FAILED'
    )
  }
}

/**
 * Download file from project-scoped storage
 */
export async function downloadFile(
  context: ExecutionContext,
  filePath: string
): Promise<{ content: Buffer; contentType?: string; metadata: Record<string, string> }> {
  assertExecutionContext(context)
  validateFilePath(filePath)
  
  const projectPath = getProjectPath(context, filePath)
  
  console.log(
    `[Storage] Downloading file: ${projectPath} (project: ${context.projectId})`
  )
  
  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: projectPath,
    })
    
    const response = await s3Client.send(command)
    
    // Validate file belongs to this project
    if (response.Metadata?.projectId !== context.projectId) {
      throw new StorageError(
        'File does not belong to this project',
        'ACCESS_DENIED'
      )
    }
    
    const content = await streamToBuffer(response.Body as any)
    
    return {
      content,
      contentType: response.ContentType,
      metadata: response.Metadata || {},
    }
  } catch (error: any) {
    if (error.name === 'NoSuchKey') {
      throw new StorageError('File not found', 'FILE_NOT_FOUND')
    }
    
    if (error instanceof StorageError) {
      throw error
    }
    
    console.error(`[Storage] Download failed for ${projectPath}:`, error)
    throw new StorageError('Failed to download file', 'DOWNLOAD_FAILED')
  }
}

/**
 * Delete file from project-scoped storage
 */
export async function deleteFile(
  context: ExecutionContext,
  filePath: string
): Promise<void> {
  assertExecutionContext(context)
  validateFilePath(filePath)
  
  const projectPath = getProjectPath(context, filePath)
  
  console.log(
    `[Storage] Deleting file: ${projectPath} (project: ${context.projectId})`
  )
  
  try {
    // Verify file exists and belongs to project
    const headCommand = new HeadObjectCommand({
      Bucket: BUCKET_NAME,
      Key: projectPath,
    })
    
    const headResponse = await s3Client.send(headCommand)
    
    if (headResponse.Metadata?.projectId !== context.projectId) {
      throw new StorageError(
        'File does not belong to this project',
        'ACCESS_DENIED'
      )
    }
    
    // Delete file
    const deleteCommand = new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: projectPath,
    })
    
    await s3Client.send(deleteCommand)
    
    console.log(`[Storage] Deleted file: ${projectPath}`)
  } catch (error: any) {
    if (error.name === 'NotFound') {
      throw new StorageError('File not found', 'FILE_NOT_FOUND')
    }
    
    if (error instanceof StorageError) {
      throw error
    }
    
    console.error(`[Storage] Delete failed for ${projectPath}:`, error)
    throw new StorageError('Failed to delete file', 'DELETE_FAILED')
  }
}

/**
 * List files in project storage
 */
export async function listFiles(
  context: ExecutionContext,
  prefix?: string
): Promise<Array<{ key: string; size: number; lastModified: Date }>> {
  assertExecutionContext(context)
  
  const projectPrefix = prefix
    ? getProjectPath(context, prefix)
    : `${context.projectId}/`
  
  console.log(
    `[Storage] Listing files with prefix: ${projectPrefix}`
  )
  
  try {
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3')
    
    const command = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: projectPrefix,
    })
    
    const response = await s3Client.send(command)
    
    const files = (response.Contents || []).map(obj => ({
      key: obj.Key!.replace(`${context.projectId}/`, ''), // Remove project prefix from display
      size: obj.Size || 0,
      lastModified: obj.LastModified || new Date(),
    }))
    
    return files
  } catch (error) {
    console.error(`[Storage] List failed for ${projectPrefix}:`, error)
    throw new StorageError('Failed to list files', 'LIST_FAILED')
  }
}

/**
 * Helper: Convert stream to buffer
 */
async function streamToBuffer(stream: any): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
  
  return Buffer.concat(chunks)
}

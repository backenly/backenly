/**
 * Mock Storage Adapter for Testing
 * 
 * Provides in-memory storage operations for tests.
 * No real S3 calls - everything is mocked locally.
 */

import { StorageQuota } from './storage-lifecycle'

interface MockBucket {
  id: string
  name: string
  projectId: string
  isPublic: boolean
  createdAt: Date
  files: Map<string, MockFile>
}

interface MockFile {
  key: string
  content: Buffer
  contentType: string
  size: number
  uploadedAt: Date
}

// In-memory storage
const mockBuckets = new Map<string, MockBucket>()
const mockFiles = new Map<string, MockFile>()

/**
 * Mock bucket provisioning
 */
export async function provisionMockBucket(
  bucketName: string,
  projectId: string,
  isPublic: boolean = false
): Promise<{ success: boolean; bucketId: string; error?: string }> {
  const bucketId = `mock-bucket-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  
  const bucket: MockBucket = {
    id: bucketId,
    name: bucketName,
    projectId,
    isPublic,
    createdAt: new Date(),
    files: new Map()
  }
  
  mockBuckets.set(bucketId, bucket)
  
  return {
    success: true,
    bucketId
  }
}

/**
 * Mock bucket deletion
 */
export async function deleteMockBucket(bucketId: string): Promise<{ success: boolean; error?: string }> {
  const bucket = mockBuckets.get(bucketId)
  if (!bucket) {
    return { success: false, error: 'Bucket not found' }
  }
  
  // Delete all files in bucket
  bucket.files.forEach((_, fileKey) => {
    mockFiles.delete(`${bucketId}/${fileKey}`)
  })
  
  mockBuckets.delete(bucketId)
  return { success: true }
}

/**
 * Mock file upload
 */
export async function uploadMockFile(
  bucketId: string,
  fileKey: string,
  content: Buffer,
  contentType: string
): Promise<{ success: boolean; url?: string; error?: string }> {
  const bucket = mockBuckets.get(bucketId)
  if (!bucket) {
    return { success: false, error: 'Bucket not found' }
  }
  
  const file: MockFile = {
    key: fileKey,
    content,
    contentType,
    size: content.length,
    uploadedAt: new Date()
  }
  
  bucket.files.set(fileKey, file)
  mockFiles.set(`${bucketId}/${fileKey}`, file)
  
  return {
    success: true,
    url: `mock:///${bucketId}/${fileKey}`
  }
}

/**
 * Mock file download
 */
export async function getMockFile(
  bucketId: string,
  fileKey: string
): Promise<{ success: boolean; content?: Buffer; contentType?: string; error?: string }> {
  const file = mockFiles.get(`${bucketId}/${fileKey}`)
  if (!file) {
    return { success: false, error: 'File not found' }
  }
  
  return {
    success: true,
    content: file.content,
    contentType: file.contentType
  }
}

/**
 * Mock file deletion
 */
export async function deleteMockFile(
  bucketId: string,
  fileKey: string
): Promise<{ success: boolean; error?: string }> {
  const bucket = mockBuckets.get(bucketId)
  if (!bucket) {
    return { success: false, error: 'Bucket not found' }
  }
  
  bucket.files.delete(fileKey)
  mockFiles.delete(`${bucketId}/${fileKey}`)
  
  return { success: true }
}

/**
 * Mock presigned URL generation
 */
export async function generateMockPresignedUrl(
  bucketId: string,
  fileKey: string,
  operation: 'get' | 'put' = 'get'
): Promise<{ success: boolean; url?: string; error?: string }> {
  const file = mockFiles.get(`${bucketId}/${fileKey}`)
  if (!file && operation === 'get') {
    return { success: false, error: 'File not found' }
  }
  
  return {
    success: true,
    url: `mock-presigned:///${bucketId}/${fileKey}?op=${operation}&expires=${Date.now() + 3600000}`
  }
}

/**
 * Mock quota check
 */
export async function checkMockQuota(projectId: string): Promise<{
  used: number
  limit: number
  fileCount: number
}> {
  let used = 0
  let fileCount = 0
  
  mockBuckets.forEach(bucket => {
    if (bucket.projectId === projectId) {
      bucket.files.forEach(file => {
        used += file.size
        fileCount++
      })
    }
  })
  
  return {
    used,
    limit: 1073741824, // 1GB mock limit
    fileCount
  }
}

/**
 * Mock list buckets
 */
export async function listMockBuckets(projectId: string): Promise<{
  success: boolean
  buckets?: Array<{ id: string; name: string; isPublic: boolean; createdAt: Date }>
  error?: string
}> {
  const buckets = Array.from(mockBuckets.values())
    .filter(b => b.projectId === projectId)
    .map(b => ({
      id: b.id,
      name: b.name,
      isPublic: b.isPublic,
      createdAt: b.createdAt
    }))
  
  return { success: true, buckets }
}

/**
 * Clear all mock data (for test cleanup)
 */
export function clearMockStorage(): void {
  mockBuckets.clear()
  mockFiles.clear()
}

/**
 * Check if mock storage is being used
 */
export function isMockStorageEnabled(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.USE_MOCK_STORAGE === 'true'
}

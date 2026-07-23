import { apiRequest } from './client'

export interface StorageBucket {
  id: string
  name: string
  isPublic: boolean
  fileCount?: number
  totalSize?: number // BigInt converted to number for JSON
}

export interface StorageFile {
  id: string
  name: string
  size: number // BigInt converted to number for JSON
  mimeType: string | null
  isPublic: boolean
  bucket: string
  createdAt: string | Date
  url: string
}

export interface StorageStats {
  totalFiles: number
  totalSize: number // BigInt converted to number for JSON
  buckets: Array<{
    name: string
    fileCount: number
    totalSize: number // BigInt converted to number for JSON
  }>
}

export interface BucketsResponse {
  buckets: StorageBucket[]
}

export interface FilesResponse {
  files: StorageFile[]
}

export interface StatsResponse {
  stats: StorageStats
}

export interface CreateBucketRequest {
  name: string
  projectId?: string
  isPublic?: boolean
}

export interface UploadFileRequest {
  file: File
  bucketId: string
  isPublic?: boolean
  projectId?: string
}

// List buckets
export async function getBuckets(projectId?: string): Promise<StorageBucket[]> {
  const data: BucketsResponse = await apiRequest<BucketsResponse>(`/api/storage/buckets`)
  return data.buckets
}

// Create bucket
export async function createBucket(
  request: CreateBucketRequest
): Promise<StorageBucket> {
  const data = await apiRequest<{ bucket: StorageBucket }>('/api/storage/buckets', {
    method: 'POST',
    body: JSON.stringify(request),
  })
  return data.bucket
}

// Delete bucket
export async function deleteBucket(bucketId: string): Promise<void> {
  await apiRequest(`/api/storage/buckets/${bucketId}`, {
    method: 'DELETE',
  })
}

// List files
export async function getFiles(options?: {
  bucketId?: string
  projectId?: string
  limit?: number
  offset?: number
  search?: string
}): Promise<StorageFile[]> {
  const params = new URLSearchParams()
  if (options?.bucketId) params.append('bucketId', options.bucketId)
  if (options?.limit) params.append('limit', options.limit.toString())
  if (options?.offset) params.append('offset', options.offset.toString())
  if (options?.search) params.append('search', options.search)

  const url = `/api/storage/files${params.toString() ? `?${params.toString()}` : ''}`
  const data: FilesResponse = await apiRequest<FilesResponse>(url)
  return data.files
}

// Upload file
export async function uploadFile(
  request: UploadFileRequest,
  onProgress?: (progress: number) => void
): Promise<StorageFile> {
  const formData = new FormData()
  formData.append('file', request.file)
  formData.append('bucketId', request.bucketId)
  if (request.isPublic !== undefined) {
    formData.append('isPublic', request.isPublic.toString())
  }
  if (request.projectId) {
    formData.append('projectId', request.projectId)
  }

  // Use XMLHttpRequest for progress tracking
  return new Promise(async (resolve, reject) => {
    try {
      // Get projectId and auth token for tenant isolation
      const { getCurrentProjectId } = await import('./client')
      const projectId = await getCurrentProjectId()
      const authToken = localStorage.getItem('auth-token')
      
      const xhr = new XMLHttpRequest()

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress) {
          const progress = (e.loaded / e.total) * 100
          onProgress(progress)
        }
      })

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const data = JSON.parse(xhr.responseText)
            resolve(data.file)
          } catch (error) {
            reject(new Error('Failed to parse response'))
          }
        } else {
          try {
            const error = JSON.parse(xhr.responseText)
            reject(new Error(error.error || 'Failed to upload file'))
          } catch {
            reject(new Error('Failed to upload file'))
          }
        }
      })

      xhr.addEventListener('error', () => {
        reject(new Error('Network error'))
      })

      // Upload is its own route — /api/storage/files only has a GET (list).
      // Posting there returned 405 and silently broke every dashboard upload.
      xhr.open('POST', '/api/storage/upload')
      
      // Add headers for tenant isolation
      if (projectId) {
        xhr.setRequestHeader('X-Project-Id', projectId)
      }
      if (authToken) {
        xhr.setRequestHeader('Authorization', `Bearer ${authToken}`)
      }
      
      xhr.send(formData)
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Failed to setup upload'))
    }
  })
}

// Delete file
export async function deleteFile(fileId: string): Promise<void> {
  await apiRequest(`/api/storage/files/${fileId}`, {
    method: 'DELETE',
  })
}

// Delete multiple files
export async function deleteFiles(fileIds: string[]): Promise<void> {
  await apiRequest('/api/storage/files/bulk', {
    method: 'DELETE',
    body: JSON.stringify({ fileIds }),
  })
}

// Get storage stats
export async function getStorageStats(projectId?: string): Promise<StorageStats> {
  const data: StatsResponse = await apiRequest<StatsResponse>('/api/storage/stats')
  return data.stats
}


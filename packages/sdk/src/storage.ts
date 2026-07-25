import type { BackenlyClient } from './client.js'
import type { StorageUploadResponse } from './types.js'
import { normalizeError } from './errors.js'

export interface StorageUploadOptions {
  /** Bucket name to upload into. Defaults to 'default'. */
  bucket?: string
  /** Make the file publicly accessible. Defaults to false. */
  isPublic?: boolean
  /** Optional image resize: width in pixels (images only). */
  width?: number
  /** Optional image resize: height in pixels (images only). */
  height?: number
  /** Output format for images: 'webp' | 'jpeg' | 'png'. */
  format?: 'webp' | 'jpeg' | 'png'
  /** JPEG/WebP quality 1–100. Defaults to 85. */
  quality?: number
}

export class StorageModule {
  constructor(private client: BackenlyClient) {}

  /**
   * Upload a file to storage.
   *
   * @example
   * // Basic upload
   * const result = await backend.storage.upload(file, 'avatars/user123.jpg')
   *
   * // Upload to specific bucket, auto-convert to WebP
   * const result = await backend.storage.upload(file, 'photos/hero.jpg', {
   *   bucket: 'images',
   *   format: 'webp',
   *   width: 1200,
   *   quality: 85,
   * })
   */
  async upload(
    file: File,
    path?: string,
    options?: StorageUploadOptions
  ): Promise<StorageUploadResponse> {
    try {
      const projectId = this.client.getProjectId()
      const formData = new FormData()
      formData.append('file', file)
      formData.append('bucket', options?.bucket || 'default')
      formData.append('path', path || file.name)
      if (options?.isPublic !== undefined) {
        formData.append('isPublic', String(options.isPublic))
      }

      // Upload rides raw fetch (FormData), not client.request(), so resolve
      // the auto-fetched anon key ourselves before building headers.
      const apiKey = await this.client.ensureApiKey()
      const userToken = this.client.getUserToken()
      const headers: HeadersInit = {}
      // Project key goes in x-api-key; Authorization is the end-user JWT's slot.
      if (apiKey) {
        headers['x-api-key'] = apiKey
      }
      if (userToken) {
        headers['X-User-Token'] = userToken
      }

      // Build query string for optional image processing
      const qs = new URLSearchParams()
      if (options?.width)   qs.set('width', String(options.width))
      if (options?.height)  qs.set('height', String(options.height))
      if (options?.format)  qs.set('format', options.format)
      if (options?.quality) qs.set('quality', String(options.quality))
      const query = qs.toString() ? `?${qs.toString()}` : ''

      const response = await fetch(
        `${this.client.getApiUrl()}/api/v1/${projectId}/storage/upload${query}`,
        { method: 'POST', headers, body: formData }
      )

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Upload failed' }))
        throw new Error(error.error || error.message || 'Upload failed')
      }

      const json = await response.json()
      // v1 API wraps response in { data: { ... } }
      const data = json.data ?? json
      return {
        url: data.url,
        path: data.path,
        size: data.size,
        id: data.id,
        contentType: data.contentType,
      } as StorageUploadResponse
    } catch (error) {
      throw normalizeError(error)
    }
  }

  /**
   * Delete a file by its ID (returned from upload).
   */
  async delete(fileId: string): Promise<{ success: boolean }> {
    try {
      const projectId = this.client.getProjectId()
      const response = await this.client.request(
        `/api/v1/${projectId}/storage/files/${fileId}`,
        { method: 'DELETE' }
      )
      const data = response?.data ?? response
      return { success: data?.deleted ?? true }
    } catch (error) {
      throw normalizeError(error)
    }
  }

  /**
   * Get the URL for a file by its ID.
   * Note: for private files this returns a metadata endpoint —
   * use the `url` returned by `upload()` for direct access.
   */
  getUrl(fileId: string): string {
    const projectId = this.client.getProjectId()
    return `${this.client.getApiUrl()}/api/v1/${projectId}/storage/files/${fileId}`
  }
}

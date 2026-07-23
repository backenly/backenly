export interface BackenlyConfig {
  projectId: string
  /**
   * Public API key for the project. Embed directly in frontend code — it is
   * safe to expose. Optional in the browser: when omitted, the SDK
   * auto-fetches the project's public anon key via the bootstrap handshake.
   */
  apiKey?: string
  apiUrl?: string
}

export interface AuthResponse {
  token: string
  user: User
}

export interface User {
  id: string
  email: string
  name?: string
  createdAt?: string
}

export interface QueryResponse<T = any> {
  data: T[]
  count: number
}

export interface InsertResponse<T = any> {
  data: T
}

export interface UpdateResponse<T = any> {
  data: T
}

export interface DeleteResponse {
  success: boolean
}

export interface StorageUploadResponse {
  url: string
  path: string
  size: number
  id?: string
  contentType?: string
}

export type OrderDirection = 'asc' | 'desc'

export interface OrderByOptions {
  ascending?: boolean
}

export interface QueryFilter {
  column: string
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'in' | 'isNull' | 'isNotNull'
  value: any
}

export interface CountResponse {
  count: number
}

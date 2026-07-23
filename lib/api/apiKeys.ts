/**
 * Client-side API helpers for API key management
 */

const API_BASE = '/api'

export interface ApiKey {
  id: string
  name: string
  key?: string // Only present on creation
  keyPrefix: string
  keyType?: 'dashboard' | 'public'
  role: 'admin' | 'read-only' | 'write' | 'ai-only' | 'client' | 'service'
  permissions: string[]
  capabilities?: string[]
  serviceRole?: boolean
  projectId?: string | null
  lastUsed?: string | null
  createdAt: string
  expiresAt?: string | null
  rateLimit?: number
  rateLimitWindow?: number
  requestCount?: number
  resetAt?: string | null
}

export interface ApiKeyUsage {
  apiKey: {
    id: string
    name: string
    rateLimit: number
    rateLimitWindow: number
    currentCount: number
    resetAt: string
  }
  usage: {
    totalRequests: number
    requestsByEndpoint: Record<string, number>
    requestsByMethod: Record<string, number>
    requestsByStatus: Record<number, number>
    averageResponseTime: number
    peakRequestsPerHour: number
  }
  period: {
    startDate: string
    endDate: string
  }
}

export interface CreateApiKeyRequest {
  name: string
  keyType?: 'dashboard' | 'public'
  role?: 'admin' | 'read-only' | 'write' | 'ai-only' | 'client' | 'service'
  permissions?: string[]
  capabilities?: string[]
  serviceRole?: boolean
  projectId?: string
  expiresAt?: string
}

export interface UpdateApiKeyRequest {
  name?: string
  role?: 'admin' | 'read-only' | 'write' | 'ai-only'
  permissions?: string[]
  expiresAt?: string | null
}

import { apiRequest } from './client'

export async function getApiKeys(): Promise<{ apiKeys: ApiKey[] }> {
  return apiRequest<{ apiKeys: ApiKey[] }>(`${API_BASE}/api-keys`)
}

export async function getApiKey(id: string): Promise<{ apiKey: ApiKey }> {
  return apiRequest<{ apiKey: ApiKey }>(`${API_BASE}/api-keys/${id}`)
}

export async function createApiKey(data: CreateApiKeyRequest): Promise<{ apiKey: ApiKey }> {
  return apiRequest<{ apiKey: ApiKey }>(`${API_BASE}/api-keys`, {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateApiKey(id: string, data: UpdateApiKeyRequest): Promise<{ apiKey: ApiKey }> {
  return apiRequest<{ apiKey: ApiKey }>(`${API_BASE}/api-keys/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function deleteApiKey(id: string): Promise<void> {
  await apiRequest(`${API_BASE}/api-keys/${id}`, {
    method: 'DELETE',
  })
}

export async function rotateApiKey(id: string): Promise<{ apiKey: { id: string; key: string; keyPrefix: string }; message: string }> {
  return apiRequest<{ apiKey: { id: string; key: string; keyPrefix: string }; message: string }>(
    `${API_BASE}/api-keys/${id}/rotate`,
    { method: 'POST' }
  )
}

export async function getApiKeyUsage(id: string, startDate?: string, endDate?: string): Promise<ApiKeyUsage> {
  const searchParams = new URLSearchParams()
  if (startDate) searchParams.set('startDate', startDate)
  if (endDate) searchParams.set('endDate', endDate)
  
  return apiRequest<ApiKeyUsage>(`${API_BASE}/api-keys/${id}/usage?${searchParams.toString()}`)
}

export async function getAllApiKeyUsage(): Promise<{ stats: Record<string, any> }> {
  return apiRequest<{ stats: Record<string, any> }>(`${API_BASE}/api-keys/usage`)
}


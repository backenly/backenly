/**
 * Client-side API helpers for auth provider management
 */

const API_BASE = '/api'

export interface AuthProvider {
  id: string
  name: string
  enabled: boolean
  configured: boolean
  type: 'email' | 'oauth'
  clientId?: string | null
  clientSecret?: string | null
  redirectUri?: string | null
  scopes: string[]
  icon?: string | null
  warning?: string | null
  codeGenerated: boolean
  lastModified?: string | null
  modifiedBy?: 'ui' | 'code' | null
  createdAt: string
  updatedAt: string
}

export interface CreateProviderRequest {
  name: 'email' | 'google' | 'github' | 'microsoft'
  enabled?: boolean
  configured?: boolean
  type: 'email' | 'oauth'
  clientId?: string
  clientSecret?: string
  redirectUri?: string
  scopes?: string[]
  icon?: string
  warning?: string
}

export interface UpdateProviderRequest {
  enabled?: boolean
  configured?: boolean
  clientId?: string
  clientSecret?: string
  redirectUri?: string
  scopes?: string[]
  warning?: string
  codeGenerated?: boolean
  modifiedBy?: 'ui' | 'code'
}

function getAuthHeaders(): HeadersInit {
  const token = localStorage.getItem('auth-token')
  return {
    'Content-Type': 'application/json',
    ...(token && { 'Authorization': `Bearer ${token}` }),
  }
}

export async function getProviders(): Promise<{ providers: AuthProvider[] }> {
  const response = await fetch(`${API_BASE}/providers`, {
    headers: getAuthHeaders(),
  })
  
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to fetch providers')
  }
  
  return await response.json()
}

export async function getProvider(id: string): Promise<{ provider: AuthProvider }> {
  const response = await fetch(`${API_BASE}/providers/${id}`, {
    headers: getAuthHeaders(),
  })
  
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to fetch provider')
  }
  
  return await response.json()
}

export async function createProvider(data: CreateProviderRequest): Promise<{ provider: AuthProvider }> {
  const response = await fetch(`${API_BASE}/providers`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(data),
  })
  
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to create provider')
  }
  
  return await response.json()
}

export async function updateProvider(id: string, data: UpdateProviderRequest): Promise<{ provider: AuthProvider }> {
  const response = await fetch(`${API_BASE}/providers/${id}`, {
    method: 'PUT',
    headers: getAuthHeaders(),
    body: JSON.stringify(data),
  })
  
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to update provider')
  }
  
  return await response.json()
}

export async function deleteProvider(id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/providers/${id}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  })
  
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to delete provider')
  }
}


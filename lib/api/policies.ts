/**
 * Client-side API helpers for auth policy management
 */

const API_BASE = '/api'

export interface AuthPolicy {
  id: string
  name: string
  description: string
  enabled: boolean
  warning?: string | null
  codeGenerated: boolean
  createdAt: string
  updatedAt: string
}

export interface CreatePolicyRequest {
  name: string
  description: string
  enabled?: boolean
  warning?: string
  codeGenerated?: boolean
}

export interface UpdatePolicyRequest {
  enabled?: boolean
  warning?: string
  codeGenerated?: boolean
  description?: string
}

function getAuthHeaders(): HeadersInit {
  const token = localStorage.getItem('auth-token')
  return {
    'Content-Type': 'application/json',
    ...(token && { 'Authorization': `Bearer ${token}` }),
  }
}

export async function getPolicies(): Promise<{ policies: AuthPolicy[] }> {
  const response = await fetch(`${API_BASE}/policies`, {
    headers: getAuthHeaders(),
  })
  
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to fetch policies')
  }
  
  return await response.json()
}

export async function getPolicy(id: string): Promise<{ policy: AuthPolicy }> {
  const response = await fetch(`${API_BASE}/policies/${id}`, {
    headers: getAuthHeaders(),
  })
  
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to fetch policy')
  }
  
  return await response.json()
}

export async function createPolicy(data: CreatePolicyRequest): Promise<{ policy: AuthPolicy }> {
  const response = await fetch(`${API_BASE}/policies`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(data),
  })
  
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to create policy')
  }
  
  return await response.json()
}

export async function updatePolicy(id: string, data: UpdatePolicyRequest): Promise<{ policy: AuthPolicy }> {
  const response = await fetch(`${API_BASE}/policies/${id}`, {
    method: 'PUT',
    headers: getAuthHeaders(),
    body: JSON.stringify(data),
  })
  
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to update policy')
  }
  
  return await response.json()
}

export async function deletePolicy(id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/policies/${id}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  })
  
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to delete policy')
  }
}

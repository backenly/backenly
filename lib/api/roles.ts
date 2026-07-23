/**
 * Client-side API helpers for role and permission management
 */

const API_BASE = '/api'

export interface Role {
  id: string
  name: string
  description?: string | null
  permissions: string[]
  userCount: number
}

export interface CreateRoleRequest {
  name: string
  description?: string
  permissions: string[]
}

export interface UpdateRoleRequest {
  name?: string
  description?: string
  permissions?: string[]
}

function getAuthHeaders(): HeadersInit {
  const token = localStorage.getItem('auth-token')
  return {
    'Content-Type': 'application/json',
    ...(token && { 'Authorization': `Bearer ${token}` }),
  }
}

export async function getRoles(): Promise<{ roles: Role[] }> {
  const response = await fetch(`${API_BASE}/roles`, {
    headers: getAuthHeaders(),
  })
  
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to fetch roles')
  }
  
  return await response.json()
}

export async function getRole(id: string): Promise<{ role: Role }> {
  const response = await fetch(`${API_BASE}/roles/${id}`, {
    headers: getAuthHeaders(),
  })
  
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to fetch role')
  }
  
  return await response.json()
}

export async function createRole(data: CreateRoleRequest): Promise<{ role: Role }> {
  const response = await fetch(`${API_BASE}/roles`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(data),
  })
  
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to create role')
  }
  
  return await response.json()
}

export async function updateRole(id: string, data: UpdateRoleRequest): Promise<{ role: Role }> {
  const response = await fetch(`${API_BASE}/roles/${id}`, {
    method: 'PUT',
    headers: getAuthHeaders(),
    body: JSON.stringify(data),
  })
  
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to update role')
  }
  
  return await response.json()
}

export async function deleteRole(id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/roles/${id}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  })
  
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to delete role')
  }
}


/**
 * Client-side API helpers for user management
 */

const API_BASE = '/api'

export interface User {
  id: string
  email: string
  name?: string | null
  provider: string
  verified: boolean
  twoFactorEnabled: boolean
  lastLogin?: string | null
  createdAt: string
  role?: string
}

export interface UserStats {
  totalUsers: number
  activeUsers: number
  activeUsersDelta: number
  verifications: number
  signups24h: number
  signupsDelta: number
  signups7d: number
}

export interface CreateUserRequest {
  email: string
  name?: string
  password?: string
  provider?: 'email' | 'google' | 'github' | 'microsoft'
  providerId?: string
  roleId?: string
  emailVerified?: boolean
  twoFactorEnabled?: boolean
}

export interface UpdateUserRequest {
  name?: string
  email?: string
  roleId?: string
  emailVerified?: boolean
  twoFactorEnabled?: boolean
  password?: string
}

function getAuthHeaders(): HeadersInit {
  const token = localStorage.getItem('auth-token')
  return {
    'Content-Type': 'application/json',
    ...(token && { 'Authorization': `Bearer ${token}` }),
  }
}

export async function getUsers(params?: {
  search?: string
  page?: number
  limit?: number
}): Promise<{ users: User[]; pagination: any }> {
  const searchParams = new URLSearchParams()
  if (params?.search) searchParams.set('search', params.search)
  if (params?.page) searchParams.set('page', params.page.toString())
  if (params?.limit) searchParams.set('limit', params.limit.toString())
  
  const response = await fetch(`${API_BASE}/users?${searchParams}`, {
    headers: getAuthHeaders(),
  })
  
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to fetch users')
  }
  
  return await response.json()
}

export async function getUser(id: string): Promise<{ user: User }> {
  const response = await fetch(`${API_BASE}/users/${id}`, {
    headers: getAuthHeaders(),
  })
  
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to fetch user')
  }
  
  return await response.json()
}

export async function createUser(data: CreateUserRequest): Promise<{ user: User }> {
  const response = await fetch(`${API_BASE}/users`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(data),
  })
  
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to create user')
  }
  
  return await response.json()
}

export async function updateUser(id: string, data: UpdateUserRequest): Promise<{ user: User }> {
  const response = await fetch(`${API_BASE}/users/${id}`, {
    method: 'PUT',
    headers: getAuthHeaders(),
    body: JSON.stringify(data),
  })
  
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to update user')
  }
  
  return await response.json()
}

export async function deleteUser(id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/users/${id}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  })
  
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to delete user')
  }
}

export async function getUserStats(): Promise<UserStats> {
  const response = await fetch(`${API_BASE}/users/stats`, {
    headers: getAuthHeaders(),
  })
  
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to fetch user stats')
  }
  
  return await response.json()
}


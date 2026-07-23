/**
 * Client-side API helpers for authentication
 */

const API_BASE = '/api'

export interface LoginRequest {
  email: string
  password: string
}

export interface RegisterRequest {
  email: string
  password: string
  name?: string
  /** Referral code captured from ?ref= on the signup page. */
  ref?: string
}

export interface AuthResponse {
  user: {
    id: string
    email: string
    name?: string | null
    emailVerified: boolean
    twoFactorEnabled?: boolean
    role?: string
  }
  token: string
}

export async function login(data: LoginRequest): Promise<AuthResponse> {
  // Clear any existing session data first
  localStorage.removeItem('auth-token')
  localStorage.removeItem('current-project-id')
  localStorage.removeItem('user-info')
  
  const response = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Login failed')
  }
  
  const result = await response.json()
  // Store token in localStorage
  if (result.token) {
    localStorage.setItem('auth-token', result.token)
  }
  
  return result
}

export async function register(data: RegisterRequest): Promise<AuthResponse> {
  const response = await fetch(`${API_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Registration failed')
  }
  
  const result = await response.json()
  // Store token in localStorage
  if (result.token) {
    localStorage.setItem('auth-token', result.token)
  }
  
  return result
}

export async function logout(): Promise<void> {
  const token = localStorage.getItem('auth-token')
  
  if (token) {
    await fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
    })
  }
  
  // Clear all user-specific data
  localStorage.removeItem('auth-token')
  localStorage.removeItem('current-project-id')
  localStorage.removeItem('user-info')
}

export async function verifyEmail(token?: string): Promise<{ message: string; emailVerified: boolean }> {
  const authToken = localStorage.getItem('auth-token')
  
  const response = await fetch(`${API_BASE}/auth/verify-email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
    },
    body: JSON.stringify({ token }),
  })
  
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Email verification failed')
  }
  
  return await response.json()
}

export function getAuthToken(): string | null {
  return localStorage.getItem('auth-token')
}

export function isAuthenticated(): boolean {
  if (typeof window === 'undefined') return false
  
  // Check localStorage
  const hasToken = !!localStorage.getItem('auth-token')
  if (hasToken) return true
  
  // Check URL as a fallback (during OAuth redirect sync)
  const params = new URLSearchParams(window.location.search)
  return params.has('token')
}


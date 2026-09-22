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
  /** Cloudflare Turnstile solve. Required once the server has a secret key. */
  turnstileToken?: string
  /** Claims a self-hosted deployment. Printed by `npm run selfhost`. */
  setupToken?: string
}

/** What a signup made right now must carry beyond an email and a password. */
export interface RegistrationRequirements {
  setupTokenRequired: boolean
}

/** A refusal from an auth route, with the machine-readable code when it sent one. */
export class AuthRequestError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message)
    this.name = 'AuthRequestError'
  }
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
  
  try {
    const { setSessionCache } = await import('@/lib/hooks/useUserSession')
    setSessionCache(result.user || null, true)
  } catch {
    // Non-critical hook sync failure
  }
  
  return result
}

export async function getRegistrationRequirements(): Promise<RegistrationRequirements> {
  const response = await fetch(`${API_BASE}/auth/register`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`registration requirements: ${response.status}`)
  return response.json()
}

/**
 * What POST /api/auth/register answers when the address must be proven first.
 * No account and no session exist yet; the code mailed to `email` creates them.
 */
export interface SignupVerificationRequired {
  status: 'verification_required'
  email: string
  expiresInSec: number
  resendAfterSec: number
}

export type RegisterResult =
  | ({ status: 'created' } & AuthResponse)
  | SignupVerificationRequired

async function readAuthError(response: Response, fallback: string): Promise<AuthRequestError> {
  const error = await response.json().catch(() => ({}))
  return new AuthRequestError(error.error || fallback, error.code)
}

/** Remember the session a successful signup or verification issued. */
async function adoptSession(result: AuthResponse): Promise<void> {
  if (result.token) {
    localStorage.setItem('auth-token', result.token)
  }
  try {
    const { setSessionCache } = await import('@/lib/hooks/useUserSession')
    setSessionCache(result.user || null, true)
  } catch {
    // Non-critical hook sync failure
  }
}

export async function register(data: RegisterRequest): Promise<RegisterResult> {
  const response = await fetch(`${API_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })

  if (!response.ok) throw await readAuthError(response, 'Registration failed')

  const result = await response.json()
  if (result.status === 'verification_required') return result as SignupVerificationRequired

  await adoptSession(result)
  return { ...result, status: 'created' }
}

/** Prove the address with the mailed code; this is what creates the account. */
export async function verifySignupCode(email: string, code: string): Promise<AuthResponse> {
  const response = await fetch(`${API_BASE}/auth/register/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code }),
  })

  if (!response.ok) throw await readAuthError(response, 'Verification failed')

  const result = await response.json()
  await adoptSession(result)
  return result
}

export async function resendSignupCode(email: string): Promise<{ resendAfterSec: number }> {
  const response = await fetch(`${API_BASE}/auth/register/resend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  if (!response.ok) throw await readAuthError(response, 'Could not send a new code')
  return response.json()
}

export async function requestPasswordResetCode(email: string): Promise<{ resendAfterSec: number }> {
  const response = await fetch(`${API_BASE}/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  if (!response.ok) throw await readAuthError(response, 'Could not send a reset code')
  return response.json()
}

export async function resetPasswordWithCode(email: string, code: string, password: string): Promise<void> {
  const response = await fetch(`${API_BASE}/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code, password }),
  })
  if (!response.ok) throw await readAuthError(response, 'Could not reset the password')
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

  try {
    const { invalidateSessionCache } = await import('@/lib/hooks/useUserSession')
    invalidateSessionCache()
  } catch {
    // Non-critical hook sync failure
  }
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


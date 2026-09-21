'use client'

import { useState, useEffect } from 'react'

export interface UserProfile {
  id: string
  email: string
  name?: string | null
  provider?: string
  role?: string
}

export interface UserSessionState {
  isLoggedIn: boolean
  isLoading: boolean
  user: UserProfile | null
}

interface CacheRecord {
  isLoggedIn: boolean
  user: UserProfile | null
}

let sessionCache: CacheRecord | null = null
let activeFetchPromise: Promise<CacheRecord> | null = null
const listeners = new Set<(state: UserSessionState) => void>()

function notifyListeners() {
  const state: UserSessionState = {
    isLoggedIn: sessionCache?.isLoggedIn ?? false,
    isLoading: sessionCache === null,
    user: sessionCache?.user ?? null,
  }
  listeners.forEach((listener) => listener(state))
}

export function setSessionCache(user: UserProfile | null, isLoggedIn = true): void {
  sessionCache = { isLoggedIn, user }
  notifyListeners()
}

export function invalidateSessionCache(): void {
  sessionCache = null
  activeFetchPromise = null
  notifyListeners()
}

/**
 * Fetch and verify the current session against /api/auth/me.
 * Deduplicates in-flight requests across multiple hook consumers.
 */
export async function checkSession(): Promise<CacheRecord> {
  if (sessionCache !== null) {
    return sessionCache
  }
  if (activeFetchPromise !== null) {
    return activeFetchPromise
  }

  activeFetchPromise = (async () => {
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('auth-token') : null
      const headers: Record<string, string> = {}
      if (token) {
        headers['Authorization'] = `Bearer ${token}`
      }

      let res = await fetch('/api/auth/me', {
        headers,
        credentials: 'include',
      })

      // If unauthorized, attempt to refresh token via cookie/rotation
      if (res.status === 401) {
        try {
          const refreshRes = await fetch('/api/auth/refresh-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
          })
          if (refreshRes.ok) {
            const refreshData = await refreshRes.json()
            if (refreshData?.token && typeof window !== 'undefined') {
              localStorage.setItem('auth-token', refreshData.token)
              headers['Authorization'] = `Bearer ${refreshData.token}`
            }
            res = await fetch('/api/auth/me', {
              headers,
              credentials: 'include',
            })
          }
        } catch {
          // Refresh failed, proceed with original response
        }
      }

      if (res.ok) {
        const data = await res.json()
        const user = data.user || data
        sessionCache = { isLoggedIn: true, user }
      } else {
        sessionCache = { isLoggedIn: false, user: null }
      }
    } catch {
      sessionCache = { isLoggedIn: false, user: null }
    } finally {
      activeFetchPromise = null
    }

    notifyListeners()
    return sessionCache!
  })()

  return activeFetchPromise
}

/**
 * Hook to access and react to user authentication status in client components.
 */
export function useUserSession(): UserSessionState {
  const [session, setSession] = useState<UserSessionState>(() => {
    return {
      isLoggedIn: sessionCache?.isLoggedIn ?? false,
      isLoading: sessionCache === null,
      user: sessionCache?.user ?? null,
    }
  })

  useEffect(() => {
    listeners.add(setSession)

    if (sessionCache === null) {
      void checkSession()
    }

    return () => {
      listeners.delete(setSession)
    }
  }, [])

  return session
}

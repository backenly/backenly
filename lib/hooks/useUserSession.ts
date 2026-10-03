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
 * The current session, from memory when it is known, otherwise verified
 * against /api/auth/me. Deduplicates in-flight requests across hook consumers.
 */
export async function checkSession(): Promise<CacheRecord> {
  if (sessionCache !== null) {
    return sessionCache
  }
  return fetchSession()
}

/**
 * The session as the server sees it now, whatever memory says. Joins a check
 * already in flight rather than starting another.
 */
export function revalidateSession(): Promise<CacheRecord> {
  return fetchSession()
}

function fetchSession(): Promise<CacheRecord> {
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
 *
 * Pass `confirmSignedIn` from a page that acts on "signed in", as the login
 * and signup pages do by leaving for the console. The cache is module memory
 * that nothing re-checks, so it can say "signed in" long after the session was
 * revoked or expired. Acting on that sent a signed-out browser to /app, the
 * console's 401 sent it back, and the login page sent it to /app again, over
 * and over. With the option, a cached "signed in" is re-confirmed with the
 * server before this hook reports it. A cached "signed out" is reported as is:
 * showing a signed-in user the form is harmless, and costs no request.
 */
export function useUserSession({ confirmSignedIn = false }: { confirmSignedIn?: boolean } = {}): UserSessionState {
  const [session, setSession] = useState<UserSessionState>(() => {
    if (confirmSignedIn && sessionCache?.isLoggedIn) {
      return { isLoggedIn: false, isLoading: true, user: null }
    }
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
    } else if (confirmSignedIn && sessionCache.isLoggedIn) {
      void revalidateSession()
    }

    return () => {
      listeners.delete(setSession)
    }
  }, [confirmSignedIn])

  return session
}

/**
 * @jest-environment jsdom
 */

import { renderHook, act, waitFor } from '@testing-library/react'
import {
  useUserSession,
  setSessionCache,
  invalidateSessionCache,
} from '@/lib/hooks/useUserSession'

describe('useUserSession hook and cache', () => {
  beforeEach(() => {
    invalidateSessionCache()
    localStorage.clear()
    jest.restoreAllMocks()
  })

  test('returns initial logged out state and updates after successful checkSession', async () => {
    const mockUser = { id: 'u1', email: 'test@example.com', name: 'Tester' }
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ user: mockUser }),
    } as Response)

    const { result } = renderHook(() => useUserSession())

    expect(result.current.isLoggedIn).toBe(false)
    expect(result.current.isLoading).toBe(true)

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.isLoggedIn).toBe(true)
    expect(result.current.user).toEqual(mockUser)
  })

  test('handles unauthenticated response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Unauthorized' }),
    } as Response)

    const { result } = renderHook(() => useUserSession())

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.isLoggedIn).toBe(false)
    expect(result.current.user).toBeNull()
  })

  test('setSessionCache updates state immediately across hooks', () => {
    const { result } = renderHook(() => useUserSession())

    const mockUser = { id: 'u2', email: 'user2@example.com' }
    act(() => {
      setSessionCache(mockUser, true)
    })

    expect(result.current.isLoggedIn).toBe(true)
    expect(result.current.user).toEqual(mockUser)

    act(() => {
      invalidateSessionCache()
    })

    expect(result.current.isLoggedIn).toBe(false)
    expect(result.current.user).toBeNull()
  })
})

// The login and signup pages leave for the console on "signed in". The cache
// is module memory nothing re-checks, and acting on a stale "signed in" sent a
// browser whose session was revoked or expired round /app -> 401 -> login ->
// /app without end.
describe('useUserSession({ confirmSignedIn }) on pages that act on "signed in"', () => {
  const user = { id: 'u1', email: 'cached@example.com' }

  function server(routes: Record<string, { status: number; body?: unknown }>) {
    const fetchMock = jest.fn(async (url: string) => {
      const route = routes[url] ?? { status: 401 }
      return { ok: route.status < 300, status: route.status, json: async () => route.body ?? {} } as Response
    })
    global.fetch = fetchMock as unknown as typeof fetch
    return { calls: (url: string) => fetchMock.mock.calls.filter(([u]) => u === url).length }
  }

  beforeEach(() => {
    invalidateSessionCache()
    localStorage.clear()
  })

  test('a cached "signed in" for a revoked session is never reported', async () => {
    setSessionCache(user, true)
    const api = server({ '/api/auth/session': { status: 200, body: { user: null, canRefresh: false } } })

    const { result } = renderHook(() => useUserSession({ confirmSignedIn: true }))
    expect(result.current.isLoggedIn).toBe(false)

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.isLoggedIn).toBe(false)
    expect(api.calls('/api/auth/session')).toBe(1)
    // The shared cache learns it too, so display-only consumers stop saying "signed in".
    expect(renderHook(() => useUserSession()).result.current.isLoggedIn).toBe(false)
  })

  test('a cached "signed in" the server confirms is reported', async () => {
    setSessionCache(user, true)
    server({ '/api/auth/session': { status: 200, body: { user } } })

    const { result } = renderHook(() => useUserSession({ confirmSignedIn: true }))

    await waitFor(() => expect(result.current.isLoggedIn).toBe(true))
    expect(result.current.user).toEqual(user)
  })

  test('an expired access session with a live refresh token is still signed in', async () => {
    setSessionCache(user, true)
    let sessionCalls = 0
    global.fetch = jest.fn(async (url: string) => {
      if (url === '/api/auth/refresh-token') {
        return { ok: true, status: 200, json: async () => ({ token: 'rotated-jwt' }) } as Response
      }
      sessionCalls += 1
      return sessionCalls === 1
        ? ({ ok: true, status: 200, json: async () => ({ user: null, canRefresh: true }) } as Response)
        : ({ ok: true, status: 200, json: async () => ({ user }) } as Response)
    }) as unknown as typeof fetch

    const { result } = renderHook(() => useUserSession({ confirmSignedIn: true }))

    await waitFor(() => expect(result.current.isLoggedIn).toBe(true))
    expect(localStorage.getItem('auth-token')).toBe('rotated-jwt')
  })

  test('a cached "signed out" costs no request', () => {
    setSessionCache(null, false)
    const api = server({})

    const { result } = renderHook(() => useUserSession({ confirmSignedIn: true }))

    expect(result.current.isLoggedIn).toBe(false)
    expect(result.current.isLoading).toBe(false)
    expect(api.calls('/api/auth/session')).toBe(0)
  })

  test('display-only consumers still read the cache without a request', () => {
    setSessionCache(user, true)
    const api = server({})

    const { result } = renderHook(() => useUserSession())

    expect(result.current.isLoggedIn).toBe(true)
    expect(api.calls('/api/auth/session')).toBe(0)
  })

  test('confirming pages mounted together share one check', async () => {
    setSessionCache(user, true)
    const api = server({ '/api/auth/session': { status: 200, body: { user } } })

    const first = renderHook(() => useUserSession({ confirmSignedIn: true }))
    const second = renderHook(() => useUserSession({ confirmSignedIn: true }))

    await waitFor(() => expect(first.result.current.isLoggedIn).toBe(true))
    await waitFor(() => expect(second.result.current.isLoggedIn).toBe(true))
    expect(api.calls('/api/auth/session')).toBe(1)
  })
})

// Production QA (2026-11-09): the signed-out login page logged a 401 from
// /api/auth/me and another from /api/auth/refresh-token on every load. The
// hook now asks /api/auth/session, which answers a signed-out browser, and
// refreshes only when the answer says a refresh cookie is there.
describe('a signed-out browser', () => {
  beforeEach(() => {
    invalidateSessionCache()
    localStorage.clear()
  })

  test('asks once, gets an answer, and tries no refresh', async () => {
    const statuses: number[] = []
    const fetchMock = jest.fn(async (url: string) => {
      const status = url === '/api/auth/session' ? 200 : 401
      statuses.push(status)
      return {
        ok: status < 300,
        status,
        json: async () => (url === '/api/auth/session' ? { user: null, canRefresh: false } : {}),
      } as Response
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const { result } = renderHook(() => useUserSession({ confirmSignedIn: true }))

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.isLoggedIn).toBe(false)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/auth/session'])
    expect(statuses.every((status) => status < 400)).toBe(true)
  })
})

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

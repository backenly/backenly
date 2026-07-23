// Mock Next.js Request before imports
global.Request = class Request {
  constructor(public url: string, public init?: any) {
    this.url = typeof url === 'string' ? url : url.url
    this.method = init?.method || 'GET'
    this.headers = new Headers(init?.headers)
  }
  headers: Headers
  method: string
}

global.Headers = class Headers {
  private _headers: Record<string, string> = {}
  constructor(init?: any) {
    if (init) {
      if (Array.isArray(init)) {
        init.forEach(([key, value]: [string, string]) => {
          this._headers[key.toLowerCase()] = value
        })
      } else {
        Object.entries(init).forEach(([key, value]: [string, any]) => {
          this._headers[key.toLowerCase()] = String(value)
        })
      }
    }
  }
  get(name: string) {
    return this._headers[name.toLowerCase()] || null
  }
  has(name: string) {
    return name.toLowerCase() in this._headers
  }
}

import { authenticateRequest } from '@/lib/auth/middleware'
import { verifySession } from '@/lib/auth/session'

// Mock session verification
jest.mock('@/lib/auth/session', () => ({
  verifySession: jest.fn(),
}))

describe('Authentication Middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

    it('should authenticate request with valid token in Authorization header', async () => {
      const mockVerifySession = require('@/lib/auth/session').verifySession
      mockVerifySession.mockResolvedValue({
        valid: true,
        userId: 'user-1',
        email: 'test@example.com',
        role: 'admin',
      })

      const request = new Request('http://localhost:3000/api/test', {
        headers: {
          authorization: 'Bearer valid-token',
        },
      }) as any

      const result = await authenticateRequest(request)

      expect(result.authenticated).toBe(true)
      expect(result.userId).toBe('user-1')
      expect(result.userEmail).toBe('test@example.com')
    })

    it('should authenticate request with valid token in cookie', async () => {
      const mockVerifySession = require('@/lib/auth/session').verifySession
      mockVerifySession.mockResolvedValue({
        valid: true,
        userId: 'user-1',
        email: 'test@example.com',
        role: 'admin',
      })

      const request = new Request('http://localhost:3000/api/test', {
        headers: {
          cookie: 'auth-token=valid-token',
        },
      }) as any
      // Mock cookies.get method
      request.cookies = {
        get: jest.fn((name: string) => {
          if (name === 'auth-token') {
            return { value: 'valid-token' }
          }
          return undefined
        }),
      }

      const result = await authenticateRequest(request)

      expect(result.authenticated).toBe(true)
      expect(result.userId).toBe('user-1')
    })

    it('should fall back to a valid cookie when the Bearer token is stale', async () => {
      // The split-brain case: login stores the session in TWO places — an
      // auto-renewing httpOnly cookie and a never-refreshed localStorage JWT the
      // browser sends as a Bearer. When the localStorage copy expires but the
      // cookie is still valid, we must authenticate off the cookie, not 401.
      const mockVerifySession = require('@/lib/auth/session').verifySession
      mockVerifySession.mockImplementation(async (token: string) =>
        token === 'valid-cookie-token'
          ? { valid: true, userId: 'user-1', email: 'test@example.com', role: 'admin' }
          : { valid: false },
      )

      const request = new Request('http://localhost:3000/api/test', {
        headers: {
          authorization: 'Bearer stale-localstorage-token',
        },
      }) as any
      request.cookies = {
        get: jest.fn((name: string) =>
          name === 'auth-token' ? { value: 'valid-cookie-token' } : undefined,
        ),
      }

      const result = await authenticateRequest(request)

      expect(result.authenticated).toBe(true)
      expect(result.userId).toBe('user-1')
    })

    it('should return unauthenticated for invalid token', async () => {
      const mockVerifySession = require('@/lib/auth/session').verifySession
      mockVerifySession.mockResolvedValue({
        valid: false,
      })

      const request = new Request('http://localhost:3000/api/test', {
        headers: {
          authorization: 'Bearer invalid-token',
        },
      }) as any

      const result = await authenticateRequest(request)

      expect(result.authenticated).toBe(false)
      expect(result.error).toBe('Invalid or expired session')
    })

    it('should return unauthenticated when no token is provided', async () => {
      const request = new Request('http://localhost:3000/api/test') as any
      request.cookies = {
        get: jest.fn(() => undefined),
      }

      const result = await authenticateRequest(request)

      expect(result.authenticated).toBe(false)
      expect(result.error).toBe('No authentication token provided')
    })
})


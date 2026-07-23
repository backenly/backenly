import { NextRequest, NextResponse } from 'next/server'
import { extractTokenFromHeader, verifyToken } from '../auth/jwt'
import { log } from '../logger'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// Authentication middleware for Next.js API routes
export function withAuth(handler: (req: NextRequest, userId: string) => Promise<NextResponse>) {
  return async (req: NextRequest) => {
    try {
      const authHeader = req.headers.get('authorization')
      const token = extractTokenFromHeader(authHeader)

      if (!token) {
        return NextResponse.json(
          { error: 'Authentication required' },
          { status: 401 }
        )
      }

      const payload = verifyToken(token)
      
      if (!payload) {
        return NextResponse.json(
          { error: 'Invalid or expired token' },
          { status: 401 }
        )
      }
      
      return await handler(req, payload.userId)
    } catch (error: any) {
      log.error('Authentication middleware error', error)
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }
  }
}

/**
 * 🔒 PRODUCTION-GRADE CORS MIDDLEWARE
 *
 * - Static allowlist for platform/dev origins
 * - Per-project dynamic allowlist read from the `connected_apps` table
 *   (canonical surface — written via lib/services/connectFrontend.ts)
 */
export function withCORS(handler: (req: NextRequest) => Promise<NextResponse>) {
  return async (req: NextRequest) => {
    const origin = req.headers.get('origin')

    // No origin header → same-origin, skip CORS
    if (!origin) {
      return await handler(req)
    }

    const response = await handler(req)
    const pathname = req.nextUrl.pathname

    // ── Static platform allowlist ──────────────────────────────────────────
    const STATIC_ORIGINS = [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3001',
      'https://backenly.com',
      'https://www.backenly.com',
      ...(process.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()).filter(Boolean) || []),
    ]

    let isAllowed = STATIC_ORIGINS.includes(origin)

    // ── Per-project dynamic allowlist (for /api/v1/[projectId]/... routes) ─
    if (!isAllowed) {
      // Extract projectId from /api/v1/{projectId}/... or /api/projects/{projectId}/...
      const projectMatch = pathname.match(/\/api\/(?:v1|projects)\/([a-f0-9-]{36})/)
      const projectId = projectMatch?.[1] ?? req.nextUrl.searchParams.get('projectId')

      if (projectId) {
        try {
          const match = await prisma.connectedApp.findFirst({
            where: { projectId, origin, isActive: true },
            select: { id: true },
          })
          if (match) {
            isAllowed = true
          }
        } catch {
          // DB unavailable — fail open (don't block the request)
          isAllowed = true
        }
      }
    }

    log.http('CORS check', { origin, allowed: isAllowed, path: pathname })

    if (isAllowed) {
      response.headers.set('Access-Control-Allow-Origin', origin)
      response.headers.set('Access-Control-Allow-Credentials', 'true')
      response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
      response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Project-ID')
    } else {
      log.warn('CORS blocked request', { origin, path: pathname })
    }

    return response
  }
}

// Error handling middleware
export function withErrorHandling(
  handler: (req: NextRequest) => Promise<NextResponse>
) {
  return async (req: NextRequest) => {
    try {
      return await handler(req)
    } catch (error: any) {
      log.error('API route error', error, {
        path: req.nextUrl.pathname,
        method: req.method,
      })

      return NextResponse.json(
        {
          error: 'Internal server error',
          message: process.env.NODE_ENV === 'development' ? error.message : undefined,
        },
        { status: 500 }
      )
    }
  }
}

// Request logging middleware
export function withLogging(
  handler: (req: NextRequest) => Promise<NextResponse>
) {
  return async (req: NextRequest) => {
    const start = Date.now()
    
    log.http('Incoming request', {
      method: req.method,
      path: req.nextUrl.pathname,
      ip: req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip'),
    })

    const response = await handler(req)

    const duration = Date.now() - start
    log.http('Request completed', {
      method: req.method,
      path: req.nextUrl.pathname,
      status: response.status,
      duration: `${duration}ms`,
    })

    return response
  }
}

// Combine multiple middlewares
export function composeMiddleware(
  ...middlewares: Array<(handler: (req: NextRequest) => Promise<NextResponse>) => (req: NextRequest) => Promise<NextResponse>>
) {
  return (handler: (req: NextRequest) => Promise<NextResponse>) => {
    return middlewares.reduceRight((acc, middleware) => middleware(acc), handler)
  }
}


import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyToken } from '@/lib/auth/jwt'
import crypto from 'crypto'
import { z } from 'zod'
import { logAuditEvent } from '@/lib/middleware/delegation'

const createConnectionSchema = z.object({
  provider: z.enum(['cursor', 'replit', 'web']),
})

/**
 * POST /api/projects/:projectId/connections
 * Create a delegated connection token for one-click frontend integration
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Verify authentication
    const authHeader = request.headers.get('authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const token = authHeader.substring(7)
    const payload = verifyToken(token)
    
    if (!payload || !payload.userId) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const projectId = params.id
    const body = await request.json()
    const { provider } = createConnectionSchema.parse(body)

    // Verify project ownership
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        userId: payload.userId,
      },
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found or access denied' }, { status: 404 })
    }

    // Revoke any existing active connections for this provider
    await prisma.delegatedConnection.updateMany({
      where: {
        projectId,
        provider,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: {
        revokedAt: new Date(),
      },
    })

    // Generate cryptographically secure delegation token
    const delegationToken = `del_${crypto.randomBytes(32).toString('hex')}`
    const tokenHash = crypto.createHash('sha256').update(delegationToken).digest('hex')

    // Capture IP address and user agent
    const ipAddress = request.headers.get('x-forwarded-for') || 
                      request.headers.get('x-real-ip') || 
                      'unknown'
    const userAgent = request.headers.get('user-agent') || 'unknown'

    // Create delegation connection (24 hour expiry)
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
    
    const connection = await prisma.delegatedConnection.create({
      data: {
        projectId,
        provider,
        tokenHash,
        permissions: {
          readSchema: true,
          readEndpoints: true,
          callApis: true,
          authenticateSessions: true,
        },
        expiresAt,
        ipAddress,
        userAgent,
      },
    })
    
    // Log creation event
    await logAuditEvent(
      connection.id,
      'created',
      request.url,
      request,
      { provider, projectId, expiresAt: expiresAt.toISOString() }
    )

    // Generate handshake URL with temporary token
    const handshakeUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/connect/${provider}?token=${delegationToken}`

    return NextResponse.json({
      connectionId: connection.id,
      provider,
      expiresAt: expiresAt.toISOString(),
      handshakeUrl,
    })
  } catch (error: any) {
    console.error('[Delegation API] Error:', error)
    
    if (error.name === 'ZodError') {
      return NextResponse.json(
        { error: 'Invalid input', details: error.errors },
        { status: 400 }
      )
    }

    return NextResponse.json(
      { error: 'Failed to create connection' },
      { status: 500 }
    )
  }
}

/**
 * GET /api/projects/:projectId/connections
 * List active delegated connections for a project
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Try cookie-based auth first, then Bearer token
    const cookieToken = request.cookies.get('auth-token')?.value
    const authHeader = request.headers.get('authorization')
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null
    
    const token = bearerToken || cookieToken
    
    if (!token) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const payload = verifyToken(token)
    
    if (!payload || !payload.userId) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const projectId = params.id

    // Verify project ownership
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        userId: payload.userId,
      },
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found or access denied' }, { status: 404 })
    }

    // Get active connections
    const connections = await prisma.delegatedConnection.findMany({
      where: {
        projectId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        provider: true,
        expiresAt: true,
        createdAt: true,
        lastUsedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({ connections })
  } catch (error: any) {
    console.error('[Delegation API] Error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch connections' },
      { status: 500 }
    )
  }
}

/**
 * DELETE /api/projects/:projectId/connections
 * Revoke a delegated connection
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Try cookie-based auth first, then Bearer token
    const cookieToken = request.cookies.get('auth-token')?.value
    const authHeader = request.headers.get('authorization')
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null
    
    const token = bearerToken || cookieToken
    
    if (!token) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const payload = verifyToken(token)
    
    if (!payload || !payload.userId) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const projectId = params.id
    const { searchParams } = new URL(request.url)
    const connectionId = searchParams.get('id') || searchParams.get('connectionId')

    if (!connectionId) {
      return NextResponse.json({ error: 'Connection ID required' }, { status: 400 })
    }

    // Verify project ownership
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        userId: payload.userId,
      },
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found or access denied' }, { status: 404 })
    }

    // Revoke the connection
    const connection = await prisma.delegatedConnection.updateMany({
      where: {
        id: connectionId,
        projectId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    })

    if (connection.count === 0) {
      return NextResponse.json({ error: 'Connection not found or already revoked' }, { status: 404 })
    }
    
    // Log revocation event
    await logAuditEvent(
      connectionId,
      'revoked',
      request.url,
      request,
      { projectId }
    )

    return NextResponse.json({ success: true, message: 'Connection revoked' })
  } catch (error: any) {
    console.error('[Delegation API] Error:', error)
    return NextResponse.json(
      { error: 'Failed to revoke connection' },
      { status: 500 }
    )
  }
}

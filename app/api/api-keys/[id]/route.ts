export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { requireAuth } from '@/lib/auth/middleware'
import { z } from 'zod'

const updateApiKeySchema = z.object({
  name: z.string().min(1).optional(),
  role: z.enum(['admin', 'read-only', 'write', 'ai-only', 'client', 'service']).optional(),
  permissions: z.array(z.string()).optional(),
  capabilities: z.array(z.enum(['database', 'auth', 'storage', 'functions', 'ai'])).optional(),
  serviceRole: z.boolean().optional(),
  expiresAt: z.string().datetime().optional().nullable(),
  rateLimit: z.number().int().positive().optional(),
  rateLimitWindow: z.number().int().positive().optional(),
})

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const auth = await requireAuth(request)

    const apiKey = await prisma.apiKey.findFirst({
      where: {
        id: params.id,
        userId: auth.userId,
      },
    })

    if (!apiKey) {
      return NextResponse.json(
        { error: 'API key not found' },
        { status: 404 }
      )
    }

    return NextResponse.json({
      apiKey: {
        id: apiKey.id,
        name: apiKey.name,
        keyPrefix: apiKey.keyPrefix,
        keyType: apiKey.keyType,
        role: apiKey.role,
        permissions: apiKey.permissions,
        capabilities: apiKey.capabilities,
        serviceRole: apiKey.serviceRole,
        projectId: apiKey.projectId,
        lastUsed: apiKey.lastUsed,
        createdAt: apiKey.createdAt,
        expiresAt: apiKey.expiresAt,
        rateLimit: apiKey.rateLimit,
        rateLimitWindow: apiKey.rateLimitWindow,
        requestCount: apiKey.requestCount,
        resetAt: apiKey.resetAt,
      },
    })
  } catch (error) {
    console.error('Get API key error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch API key' },
      { status: 500 }
    )
  }
}

export async function PUT(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const auth = await requireAuth(request)
    const body = await request.json()
    const data = updateApiKeySchema.parse(body)

    const updateData: any = {}
    if (data.name !== undefined) updateData.name = data.name
    if (data.role !== undefined) updateData.role = data.role
    if (data.permissions !== undefined) updateData.permissions = data.permissions
    if (data.capabilities !== undefined) updateData.capabilities = data.capabilities
    if (data.serviceRole !== undefined) updateData.serviceRole = data.serviceRole
    if (data.expiresAt !== undefined) {
      updateData.expiresAt = data.expiresAt ? new Date(data.expiresAt) : null
    }
    if (data.rateLimit !== undefined) updateData.rateLimit = data.rateLimit
    if (data.rateLimitWindow !== undefined) {
      updateData.rateLimitWindow = data.rateLimitWindow
      // Reset the counter when window changes
      const now = new Date()
      updateData.resetAt = new Date(now.getTime() + data.rateLimitWindow * 1000)
      updateData.requestCount = 0
    }

    const apiKey = await prisma.apiKey.updateMany({
      where: {
        id: params.id,
        userId: auth.userId,
      },
      data: updateData,
    })

    if (apiKey.count === 0) {
      return NextResponse.json(
        { error: 'API key not found' },
        { status: 404 }
      )
    }

    const updated = await prisma.apiKey.findUnique({
      where: { id: params.id },
    })

    return NextResponse.json({
      apiKey: {
        id: updated!.id,
        name: updated!.name,
        keyPrefix: updated!.keyPrefix,
        keyType: updated!.keyType,
        role: updated!.role,
        permissions: updated!.permissions,
        capabilities: updated!.capabilities,
        serviceRole: updated!.serviceRole,
        projectId: updated!.projectId,
        lastUsed: updated!.lastUsed,
        createdAt: updated!.createdAt,
        expiresAt: updated!.expiresAt,
        rateLimit: updated!.rateLimit,
        rateLimitWindow: updated!.rateLimitWindow,
        requestCount: updated!.requestCount,
        resetAt: updated!.resetAt,
      },
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.errors[0].message },
        { status: 400 }
      )
    }

    console.error('Update API key error:', error)
    return NextResponse.json(
      { error: 'Failed to update API key' },
      { status: 500 }
    )
  }
}

export async function DELETE(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const auth = await requireAuth(request)

    const result = await prisma.apiKey.deleteMany({
      where: {
        id: params.id,
        userId: auth.userId,
      },
    })

    if (result.count === 0) {
      return NextResponse.json(
        { error: 'API key not found' },
        { status: 404 }
      )
    }

    return NextResponse.json({ message: 'API key deleted successfully' })
  } catch (error) {
    console.error('Delete API key error:', error)
    return NextResponse.json(
      { error: 'Failed to delete API key' },
      { status: 500 }
    )
  }
}

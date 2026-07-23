/**
 * Trigger Delivery Log API (DLQ)
 * GET  /api/v1/[projectId]/triggers/deliveries          → list delivery logs (all or filtered by status)
 * POST /api/v1/[projectId]/triggers/deliveries          → replay a dead delivery { id }
 *
 * Only accessible by the platform user who owns the project.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth/jwt'
import { prisma } from '@/lib/db'
import { listDeliveryLogs, replayDelivery } from '@/lib/services/trigger-service'

async function authenticate(req: NextRequest, projectId: string) {
  const token = req.cookies.get('auth-token')?.value
  if (!token) return { error: 'Unauthorized' }
  let decoded: Awaited<ReturnType<typeof verifyToken>> | null = null
  try { decoded = await verifyToken(token) } catch { decoded = null }
  if (!decoded) return { error: 'Invalid token' }
  const project = await prisma.project.findFirst({ where: { id: projectId, userId: decoded.userId } })
  if (!project) return { error: 'Project not found or access denied' }
  return { userId: decoded.userId }
}

// GET — list delivery logs
// ?status=DEAD|SUCCESS|FAILED  ?limit=50
export async function GET(req: NextRequest, { params }: { params: { projectId: string } }) {
  const auth = await authenticate(req, params.projectId)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: 401 })

  const status = req.nextUrl.searchParams.get('status') as 'SUCCESS' | 'FAILED' | 'DEAD' | null
  const limit = parseInt(req.nextUrl.searchParams.get('limit') ?? '50', 10)

  const logs = await listDeliveryLogs(params.projectId, {
    status: status ?? undefined,
    limit: Math.min(limit, 200),
  })

  return NextResponse.json({ deliveries: logs })
}

// POST — replay a dead delivery
// Body: { id: string }
export async function POST(req: NextRequest, { params }: { params: { projectId: string } }) {
  const auth = await authenticate(req, params.projectId)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: 401 })

  const body = await req.json()
  const { id } = body

  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const result = await replayDelivery(params.projectId, id)

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 422 })
  }

  return NextResponse.json({ success: true })
}

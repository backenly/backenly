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
import { listDeliveryLogs, replayDelivery } from '@/lib/services/trigger-service'
import { canAccessProject, canWriteProject } from '@/lib/edition/guard'

/**
 * Authentication only: who is calling, or null.
 *
 * This was `authenticate(req, projectId)` and it did two jobs behind one shape:
 * read the session AND check owner-only project access, with both failures
 * answered 401. An organization member who simply lacked access was told to
 * re-authenticate, which cannot help. Authorization now happens per handler,
 * against the authority the operation actually needs.
 */
async function authenticate(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get('auth-token')?.value
  if (!token) return null
  let decoded: Awaited<ReturnType<typeof verifyToken>> | null = null
  try { decoded = await verifyToken(token) } catch { decoded = null }
  if (!decoded) return null
  return decoded.userId
}

// GET — list delivery logs
// ?status=DEAD|SUCCESS|FAILED  ?limit=50
export async function GET(req: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  const userId = await authenticate(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await canAccessProject(userId, params.projectId))) {
    return NextResponse.json({ error: 'Project not found or access denied' }, { status: 404 })
  }

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
export async function POST(req: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  const userId = await authenticate(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await canWriteProject(userId, params.projectId))) {
    return NextResponse.json({ error: 'Project not found or access denied' }, { status: 404 })
  }

  const body = await req.json()
  const { id } = body

  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const result = await replayDelivery(params.projectId, id)

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 422 })
  }

  return NextResponse.json({ success: true })
}

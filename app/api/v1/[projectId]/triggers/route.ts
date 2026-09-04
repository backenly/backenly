/**
 * Trigger Management API (platform-level, requires platform JWT cookie)
 * GET    /api/v1/[projectId]/triggers        → List all triggers
 * POST   /api/v1/[projectId]/triggers        → Create trigger
 * DELETE /api/v1/[projectId]/triggers?id=    → Delete trigger
 *
 * Trigger *firing* happens automatically server-side inside the DB routes.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth/jwt'
import { prisma } from '@/lib/db'
import { listTriggers, createTrigger, deleteTrigger } from '@/lib/services/trigger-service'
import { enforceTriggerCreation } from '@/lib/billing'
import { canAccessProject, canAdministerProject, canWriteProject } from '@/lib/edition/guard'

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

export async function GET(req: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  const userId = await authenticate(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await canAccessProject(userId, params.projectId))) {
    return NextResponse.json({ error: 'Project not found or access denied' }, { status: 404 })
  }
  const triggers = await listTriggers(params.projectId)
  return NextResponse.json({ triggers })
}

export async function POST(req: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  const userId = await authenticate(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await canWriteProject(userId, params.projectId))) {
    return NextResponse.json({ error: 'Project not found or access denied' }, { status: 404 })
  }

  const body = await req.json()
  const { name, description, sourceTable, event, conditions, actionType, targetTable, fieldMappings, staticFields, webhookUrl } = body

  if (!name || !sourceTable || !event || !actionType) {
    return NextResponse.json({ error: 'name, sourceTable, event, and actionType are required' }, { status: 400 })
  }

  // ─── Plan enforcement: trigger limit per project ──────────────────────
  const currentTriggerCount = await prisma.appTrigger.count({ where: { projectId: params.projectId } })
  const triggerCheck = await enforceTriggerCreation(userId, params.projectId, currentTriggerCount)
  if (triggerCheck !== true) {
    return NextResponse.json(
      {
        error: triggerCheck.message,
        code: triggerCheck.code,
        upgradeRequired: triggerCheck.upgradeRequired,
        currentPlan: triggerCheck.currentPlan,
        requiredPlan: triggerCheck.requiredPlan,
      },
      { status: 403 }
    )
  }

  const trigger = await createTrigger(params.projectId, {
    name, description, sourceTable, event, conditions,
    actionType, targetTable, fieldMappings, staticFields, webhookUrl,
  })
  return NextResponse.json({ trigger }, { status: 201 })
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  const userId = await authenticate(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await canAdministerProject(userId, params.projectId))) {
    return NextResponse.json({ error: 'Project not found or access denied' }, { status: 404 })
  }

  const triggerId = req.nextUrl.searchParams.get('id')
  if (!triggerId) return NextResponse.json({ error: 'id query parameter is required' }, { status: 400 })

  await deleteTrigger(params.projectId, triggerId)
  return NextResponse.json({ success: true })
}

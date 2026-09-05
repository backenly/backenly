export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { createWebhook, getProjectWebhooks, deleteWebhook, toggleWebhook } from '@/lib/webhooks'
import { enforceWebhook } from '@/lib/entitlements/policy'
import { canAccessProject, canAdministerProject, canWriteProject } from '@/lib/edition/guard'

/**
 * GET /api/projects/[id]/webhooks
 * List all webhooks for a project
 * 🔒 Protected: Requires authentication + PRO plan
 */
export const GET = withAuth(async (request: NextRequest, { user, params }) => {
  try {
    const { id: projectId } = await params

    // Check if user owns this project
    if (!(await canAccessProject(user.userId, projectId))) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Enforce PRO plan requirement
    const entitlementCheck = await enforceWebhook(user.userId)
    if (entitlementCheck !== true) {
      return NextResponse.json({
        error: 'Webhooks require PRO plan',
        code: 'PLAN_LIMIT_EXCEEDED',
        upgradeRequired: true,
        currentPlan: entitlementCheck.currentPlan,
        requiredPlan: 'PRO'
      }, { status: 403 })
    }

    const webhooks = await getProjectWebhooks(projectId)
    
    // Don't expose the secret in the response
    const sanitized = webhooks.map(w => ({
      id: w.id,
      eventType: w.eventType,
      targetUrl: w.targetUrl,
      active: w.active,
      createdAt: w.createdAt,
      logCount: w._count.logs
    }))

    return NextResponse.json({ webhooks: sanitized })

  } catch (error: any) {
    console.error('[Webhooks GET] Error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to fetch webhooks' },
      { status: 500 }
    )
  }
})

/**
 * POST /api/projects/[id]/webhooks
 * Create a new webhook
 * 🔒 Protected: Requires authentication + PRO plan
 */
export const POST = withAuth(async (request: NextRequest, { user, params }) => {
  try {
    const { id: projectId } = await params
    const body = await request.json()
    const { eventType, targetUrl } = body

    // Validate input
    if (!eventType || !targetUrl) {
      return NextResponse.json(
        { error: 'eventType and targetUrl are required' },
        { status: 400 }
      )
    }

    // Validate event type
    const validEvents = ['row.inserted', 'row.deleted', 'auth.user.created']
    if (!validEvents.includes(eventType)) {
      return NextResponse.json(
        { error: `Invalid eventType. Must be one of: ${validEvents.join(', ')}` },
        { status: 400 }
      )
    }

    // Validate URL
    try {
      new URL(targetUrl)
    } catch {
      return NextResponse.json(
        { error: 'Invalid targetUrl' },
        { status: 400 }
      )
    }

    // Check if user owns this project
    if (!(await canWriteProject(user.userId, projectId))) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Enforce PRO plan requirement
    const entitlementCheck = await enforceWebhook(user.userId)
    if (entitlementCheck !== true) {
      return NextResponse.json({
        error: 'Webhooks require PRO plan',
        code: 'PLAN_LIMIT_EXCEEDED',
        upgradeRequired: true,
        currentPlan: entitlementCheck.currentPlan,
        requiredPlan: 'PRO'
      }, { status: 403 })
    }

    const webhook = await createWebhook(projectId, eventType, targetUrl)

    return NextResponse.json({
      webhook: {
        id: webhook.id,
        eventType: webhook.eventType,
        targetUrl: webhook.targetUrl,
        active: webhook.active,
        createdAt: webhook.createdAt,
        secret: webhook.secret // Only shown once on creation
      }
    }, { status: 201 })

  } catch (error: any) {
    console.error('[Webhooks POST] Error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to create webhook' },
      { status: 500 }
    )
  }
})

/**
 * DELETE /api/projects/[id]/webhooks
 * Delete a webhook
 * 🔒 Protected: Requires authentication + PRO plan
 */
export const DELETE = withAuth(async (request: NextRequest, { user, params }) => {
  try {
    const { id: projectId } = await params
    const { searchParams } = new URL(request.url)
    const webhookId = searchParams.get('webhookId')

    if (!webhookId) {
      return NextResponse.json(
        { error: 'webhookId is required' },
        { status: 400 }
      )
    }

    // Check if user owns this project
    if (!(await canAdministerProject(user.userId, projectId))) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Enforce PRO plan requirement
    const entitlementCheck = await enforceWebhook(user.userId)
    if (entitlementCheck !== true) {
      return NextResponse.json({
        error: 'Webhooks require PRO plan',
        code: 'PLAN_LIMIT_EXCEEDED',
        upgradeRequired: true,
        currentPlan: entitlementCheck.currentPlan,
        requiredPlan: 'PRO'
      }, { status: 403 })
    }

    await deleteWebhook(webhookId, projectId)

    return NextResponse.json({ success: true })

  } catch (error: any) {
    console.error('[Webhooks DELETE] Error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to delete webhook' },
      { status: 500 }
    )
  }
})

/**
 * PATCH /api/projects/[id]/webhooks
 * Toggle webhook active status
 * 🔒 Protected: Requires authentication + PRO plan
 */
export const PATCH = withAuth(async (request: NextRequest, { user, params }) => {
  try {
    const { id: projectId } = await params
    const body = await request.json()
    const { webhookId, active } = body

    if (!webhookId || typeof active !== 'boolean') {
      return NextResponse.json(
        { error: 'webhookId and active are required' },
        { status: 400 }
      )
    }

    // Check if user owns this project
    if (!(await canWriteProject(user.userId, projectId))) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Enforce PRO plan requirement
    const entitlementCheck = await enforceWebhook(user.userId)
    if (entitlementCheck !== true) {
      return NextResponse.json({
        error: 'Webhooks require PRO plan',
        code: 'PLAN_LIMIT_EXCEEDED',
        upgradeRequired: true,
        currentPlan: entitlementCheck.currentPlan,
        requiredPlan: 'PRO'
      }, { status: 403 })
    }

    await toggleWebhook(webhookId, projectId, active)

    return NextResponse.json({ success: true })

  } catch (error: any) {
    console.error('[Webhooks PATCH] Error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to update webhook' },
      { status: 500 }
    )
  }
})

export const dynamic = 'force-dynamic'

/**
 * Integration Key Vault — Platform API
 *
 * POST   /api/projects/[id]/integrations/keys
 *   Body: { integrationId: string, key: string }
 *   Encrypts and stores an integration API key (e.g. stripe_webhook_secret).
 *   Returns the masked key — the raw value never leaves the server.
 *
 * DELETE /api/projects/[id]/integrations/keys?integrationId=<id>
 *   Removes a stored key from the vault.
 *
 * GET    /api/projects/[id]/integrations/keys
 *   Returns all masked keys for the project (safe to display in UI).
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { prisma } from '@/lib/db/prisma'
import {
  storeIntegrationKey,
  listKeyVaultStatuses,
} from '@/lib/services/integrationKeyStore'

// ── GET — list all stored keys (masked) ───────────────────────────────────────

export const GET = withProjectAccess(async (_req: NextRequest, { projectId }) => {
  const keys = await listKeyVaultStatuses(projectId)
  return NextResponse.json({ success: true, data: keys })
})

// ── POST — store or update a key ──────────────────────────────────────────────

export const POST = withProjectAccess(async (req: NextRequest, { projectId }) => {
  let body: { integrationId?: string; key?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  const { integrationId, key } = body

  if (!integrationId || typeof integrationId !== 'string') {
    return NextResponse.json(
      { success: false, error: 'integrationId is required' },
      { status: 400 },
    )
  }

  if (!key || typeof key !== 'string' || key.trim().length === 0) {
    return NextResponse.json(
      { success: false, error: 'key is required' },
      { status: 400 },
    )
  }

  try {
    const status = await storeIntegrationKey(projectId, integrationId, key.trim())

    // Dismiss any open broken_webhook HealthFindings for this integration so
    // they don't re-appear before the next observer cycle re-evaluates them.
    // Strategy: try the precise JSONB path filter first; fall back to clearing
    // ALL broken_webhook findings for this project if JSONB filtering fails.
    // The fallback is safe — the observer will re-raise findings still broken.
    try {
      await prisma.healthFinding.updateMany({
        where: {
          projectId,
          type: 'broken_webhook',
          status: { in: ['open', 'pending_approval'] },
          details: { path: ['integrationId'], equals: integrationId },
        },
        data: { status: 'dismissed' },
      })
    } catch {
      await prisma.healthFinding.updateMany({
        where: {
          projectId,
          type: 'broken_webhook',
          status: { in: ['open', 'pending_approval'] },
        },
        data: { status: 'dismissed' },
      }).catch(() => {})
    }

    // Audit the key storage action
    await prisma.auditLog.create({
      data: {
        projectId,
        action: 'INTEGRATION_KEY_STORED',
        type: 'integration',
        details: JSON.stringify({ integrationId, maskedKey: status.maskedKey }),
        timestamp: new Date(),
      },
    }).catch(() => {})

    const response: Record<string, unknown> = { success: true, data: status }
    if (status.formatWarning) response.warning = status.formatWarning

    return NextResponse.json(response)
  } catch (err: any) {
    const isDangerousSecret = err?.message?.includes('Refused to store')
    const isFormatError = err?.isFormatError === true
    return NextResponse.json(
      { success: false, error: err?.message ?? 'Failed to store key' },
      { status: isDangerousSecret || isFormatError ? 422 : 500 },
    )
  }
})

// ── DELETE — remove a key ─────────────────────────────────────────────────────

export const DELETE = withProjectAccess(async (req: NextRequest, { projectId }) => {
  const { searchParams } = new URL(req.url)
  const integrationId = searchParams.get('integrationId')

  if (!integrationId) {
    return NextResponse.json(
      { success: false, error: 'integrationId query param is required' },
      { status: 400 },
    )
  }

  await prisma.projectIntegrationKey.deleteMany({
    where: { projectId, integrationId },
  })

  await prisma.auditLog.create({
    data: {
      projectId,
      action: 'INTEGRATION_KEY_REMOVED',
      type: 'integration',
      details: JSON.stringify({ integrationId }),
      timestamp: new Date(),
    },
  }).catch(() => {})

  return NextResponse.json({ success: true })
})

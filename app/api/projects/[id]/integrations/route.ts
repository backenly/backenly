/**
 * Project Integrations API
 *
 * GET  /api/projects/[id]/integrations  — Active integrations + key vault statuses
 * POST /api/projects/[id]/integrations  — Activate an integration (called by AI chat)
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { listKeyVaultStatuses } from '@/lib/services/integrationKeyStore'

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ id: string }> }
) {
  const params = await props.params
  return withProjectValidation<any>(request, async (validated) => {
    const [project, keyStatuses] = await Promise.all([
      prisma.project.findUnique({
        where: { id: validated.projectId },
        select: { activeIntegrations: true },
      }),
      listKeyVaultStatuses(validated.projectId),
    ])

    // Build a lookup: integrationId → masked key + what the provider said.
    // verification/verificationDetail travel to the console on purpose: the
    // store's contract says never to fold them into a boolean "connected" —
    // a key the provider REJECTED rendering as a green "Connected" card is
    // exactly how a dead credential sits unnoticed until a function fails.
    const keyVault: Record<
      string,
      { maskedKey: string; connectedAt: string; verification: string; verificationDetail?: string }
    > = {}
    for (const ks of keyStatuses) {
      keyVault[ks.integrationId] = {
        maskedKey: ks.maskedKey,
        connectedAt: ks.connectedAt,
        verification: ks.verification,
        verificationDetail: ks.verificationDetail,
      }
    }

    return NextResponse.json({
      integrations: (project?.activeIntegrations as Record<string, any>) ?? {},
      keyVault,
    })
  })
}

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ id: string }> }
) {
  const params = await props.params
  return withProjectValidation<any>(request, async (validated) => {
    const body = await request.json()
    const { integrationId, categoryId, name, provisions, activatedBy } = body

    if (!integrationId) {
      return NextResponse.json({ error: 'integrationId required' }, { status: 400 })
    }

    const project = await prisma.project.findUnique({
      where: { id: validated.projectId },
      select: { activeIntegrations: true },
    })

    const existing = (project?.activeIntegrations as Record<string, any>) ?? {}

    // Idempotent — don't overwrite an already-active integration
    if (existing[integrationId]?.enabled) {
      return NextResponse.json({ integrations: existing, alreadyActive: true })
    }

    const updated = {
      ...existing,
      [integrationId]: {
        enabled: true,
        categoryId,
        name,
        provisions: provisions ?? [],
        activatedAt: new Date().toISOString(),
        activatedBy: activatedBy ?? 'intent',
      },
    }

    await prisma.project.update({
      where: { id: validated.projectId },
      data: { activeIntegrations: updated },
    })

    return NextResponse.json({ integrations: updated, activated: integrationId })
  })
}

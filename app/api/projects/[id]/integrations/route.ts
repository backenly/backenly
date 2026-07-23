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
  { params }: { params: { id: string } }
) {
  return withProjectValidation<any>(request, async (validated) => {
    const [project, keyStatuses] = await Promise.all([
      prisma.project.findUnique({
        where: { id: validated.projectId },
        select: { activeIntegrations: true },
      }),
      listKeyVaultStatuses(validated.projectId),
    ])

    // Build a lookup: integrationId → maskedKey
    const keyVault: Record<string, { maskedKey: string; connectedAt: string }> = {}
    for (const ks of keyStatuses) {
      keyVault[ks.integrationId] = { maskedKey: ks.maskedKey, connectedAt: ks.connectedAt }
    }

    return NextResponse.json({
      integrations: (project?.activeIntegrations as Record<string, any>) ?? {},
      keyVault,
    })
  })
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
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

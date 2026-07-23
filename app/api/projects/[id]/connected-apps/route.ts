export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/auth/route-protection'
import { prisma } from '@/lib/db'
import {
  connectFrontend,
  disconnectFrontend,
  listConnectedApps,
} from '@/lib/services/connectFrontend'

/**
 * REST surface for the Connect Frontend page.
 *
 *   GET    /api/projects/:id/connected-apps         → list (active + inactive)
 *   POST   /api/projects/:id/connected-apps         → connect a frontend URL
 *   DELETE /api/projects/:id/connected-apps?url=... → disconnect
 *
 * All routes funnel through lib/services/connectFrontend.ts so the deploy gate,
 * normalization, version pinning, and audit logging cannot be bypassed.
 */

function extractProjectId(request: NextRequest): string | null {
  const parts = new URL(request.url).pathname.split('/').filter(Boolean)
  const i = parts.indexOf('projects')
  return i >= 0 && parts[i + 1] ? parts[i + 1] : null
}

async function assertOwner(projectId: string, userId: string): Promise<boolean> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, userId },
    select: { id: true },
  })
  return !!project
}

// ─── GET ─────────────────────────────────────────────────────────────────────

export const GET = withAuth(async (request: NextRequest, { user }) => {
  const projectId = extractProjectId(request)
  if (!projectId) {
    return NextResponse.json({ error: 'Invalid project id' }, { status: 400 })
  }
  if (!(await assertOwner(projectId, user.userId))) {
    return NextResponse.json({ error: 'Project not found or access denied' }, { status: 404 })
  }

  const apps = await listConnectedApps(projectId)
  return NextResponse.json({ apps })
})

// ─── POST (connect) ──────────────────────────────────────────────────────────

const connectSchema = z.object({
  url: z.string().min(1).max(2048),
  force: z.boolean().optional(),
})

export const POST = withAuth(async (request: NextRequest, { user }) => {
  const projectId = extractProjectId(request)
  if (!projectId) {
    return NextResponse.json({ error: 'Invalid project id' }, { status: 400 })
  }
  if (!(await assertOwner(projectId, user.userId))) {
    return NextResponse.json({ error: 'Project not found or access denied' }, { status: 404 })
  }

  let body: z.infer<typeof connectSchema>
  try {
    body = connectSchema.parse(await request.json())
  } catch (err: any) {
    return NextResponse.json({ error: 'Invalid request', details: err?.errors }, { status: 400 })
  }

  const result = await connectFrontend({
    projectId,
    frontendUrl: body.url,
    userId: user.userId,
    confirmedBy: 'UI',
    force: !!body.force,
  })

  // Distinguish:
  //   200 → connected
  //   202 → confirmation required (UI shows the prompt + "Type CONNECT")
  //   400 → invalid URL
  //   409 → backend not deployed / already connected (success:false from engine)
  const status = result.connected
    ? 200
    : result.requiresConfirmation
      ? 202
      : result.success
        ? 200
        : 409
  return NextResponse.json(result, { status })
})

// ─── DELETE (disconnect) ─────────────────────────────────────────────────────

export const DELETE = withAuth(async (request: NextRequest, { user }) => {
  const projectId = extractProjectId(request)
  if (!projectId) {
    return NextResponse.json({ error: 'Invalid project id' }, { status: 400 })
  }
  if (!(await assertOwner(projectId, user.userId))) {
    return NextResponse.json({ error: 'Project not found or access denied' }, { status: 404 })
  }

  const url = new URL(request.url).searchParams.get('url')
  const force = new URL(request.url).searchParams.get('force') === 'true'
  if (!url) {
    return NextResponse.json({ error: 'url query param required' }, { status: 400 })
  }

  const result = await disconnectFrontend({
    projectId,
    origin: url,
    userId: user.userId,
    confirmedBy: 'UI',
    force,
  })

  const status = result.disconnected
    ? 200
    : result.requiresConfirmation
      ? 202
      : 409
  return NextResponse.json(result, { status })
})

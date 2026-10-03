export const dynamic = 'force-dynamic'

/**
 * PostgreSQL extensions for this deployment.
 *
 * Extensions are DATABASE-wide, not per-schema, so this is deployment
 * administration reached through a project. On self-host that distinction is
 * theoretical — one deployment is one project — but the authorization is still
 * per project, and installing one is held at ADMIN because it changes the
 * database every project in the deployment shares.
 *
 * No DELETE. `DROP EXTENSION` cascades into columns and indexes that depend on
 * it, and the dashboard cannot show an operator what a CASCADE would take with
 * it. See lib/services/extensions.ts.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { canAccessProject, canAdministerProject } from '@/lib/edition/guard'
import { installExtension, isAllowedExtension, listExtensions } from '@/lib/services/extensions'

export const GET = withAuth(async (_request: NextRequest, { user, params }) => {
  const { id: projectId } = await params
  if (!(await canAccessProject(user.userId, projectId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  // Read from the live catalog every time. A cached list is how a dashboard
  // ends up reporting an extension that an operator removed at a psql prompt.
  return NextResponse.json({ extensions: await listExtensions() })
})

export const POST = withAuth(async (request: NextRequest, { user, params }) => {
  const { id: projectId } = await params
  if (!(await canAdministerProject(user.userId, projectId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  const body = await request.json().catch(() => null)
  const name = body?.name

  // Checked before anything composes SQL. The allowlist is the control; the
  // quoting inside the service is defence in depth.
  if (!isAllowedExtension(name)) {
    return NextResponse.json(
      { error: 'That extension is not on Backenly’s allowlist.', code: 'NOT_ALLOWED' },
      { status: 400 },
    )
  }

  const result = await installExtension(name)

  if (result.ok) {
    return NextResponse.json({
      installed: true,
      alreadyInstalled: result.alreadyInstalled,
      version: result.version,
      extensions: await listExtensions(),
    })
  }

  // NEEDS_SUPERUSER is a 409, not a 403: the caller is entitled to ask, and the
  // DATABASE is what refuses. A 403 would read as a problem with their account.
  const status = result.code === 'NEEDS_SUPERUSER' || result.code === 'NOT_AVAILABLE' ? 409 : 400
  return NextResponse.json({ error: result.message, code: result.code }, { status })
})

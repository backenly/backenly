export const dynamic = 'force-dynamic'

/**
 * Every auth email kind, with the operator's override when there is one.
 *
 * Returns all three kinds whether or not they are customised, because the
 * dashboard's job is to show what WILL be sent. A list of only the overrides
 * would leave an operator unable to tell "using the built-in" from "this kind
 * does not exist".
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { canAccessProject } from '@/lib/edition/guard'
import { listProjectTemplates } from '@/lib/email/project-templates'

export const GET = withAuth(async (_request: NextRequest, { user, params }) => {
  const { id: projectId } = await params
  if (!(await canAccessProject(user.userId, projectId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  // Shared with the agent's auth email_settings (lib/email/project-templates.ts).
  return NextResponse.json(await listProjectTemplates(projectId))
})

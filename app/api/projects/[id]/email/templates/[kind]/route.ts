export const dynamic = 'force-dynamic'

/**
 * Store or remove one operator-authored auth email.
 *
 * DELETE reverts to the built-in rather than leaving the project with nothing.
 * There is no state in which a kind has no template: absence of a row IS the
 * built-in, which is why reverting is safe and why it cannot break a flow.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { canWriteProject } from '@/lib/edition/guard'
import { isTemplateKind } from '@/lib/email/template-kinds'
import { revertProjectTemplate, saveProjectTemplate } from '@/lib/email/project-templates'

export const PUT = withAuth(async (request: NextRequest, { user, params }) => {
  const { id: projectId, kind } = await params
  if (!isTemplateKind(kind)) {
    return NextResponse.json({ error: 'Unknown template' }, { status: 404 })
  }
  if (!(await canWriteProject(user.userId, projectId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  const body = await request.json().catch(() => null)
  const subject = typeof body?.subject === 'string' ? body.subject : ''
  const bodyHtml = typeof body?.bodyHtml === 'string' ? body.bodyHtml : ''

  // Refused HERE, at the dashboard, while the operator is looking at it.
  // Discovering a broken template at send time means discovering it during
  // somebody's password reset, and that person did not author it. Shared with
  // the agent's auth set_email_template (lib/email/project-templates.ts).
  const result = await saveProjectTemplate(projectId, kind, subject, bodyHtml)
  if ('errors' in result) {
    return NextResponse.json({ error: 'This template cannot be used', errors: result.errors }, { status: 400 })
  }

  return NextResponse.json({ template: result.template })
})

export const DELETE = withAuth(async (_request: NextRequest, { user, params }) => {
  const { id: projectId, kind } = await params
  if (!isTemplateKind(kind)) {
    return NextResponse.json({ error: 'Unknown template' }, { status: 404 })
  }
  if (!(await canWriteProject(user.userId, projectId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  // deleteMany scoped by BOTH ids: a kind belonging to another project matches
  // nothing rather than being read and confirmed to exist.
  return NextResponse.json({ reverted: await revertProjectTemplate(projectId, kind) })
})

export const dynamic = 'force-dynamic'

/**
 * Per-project SMTP settings.
 *
 * No entitlement gate. Sending a password-reset email is not a plan feature, it
 * is part of auth working at all, and gating it would mean a project whose users
 * cannot recover their accounts until somebody upgrades.
 *
 * ADMIN for writes. Repointing where a project's auth mail comes from is not an
 * ordinary edit: get it wrong and every verification and reset silently stops
 * arriving, which is the same "not undoable from the dashboard" bar that holds
 * deletion a rank above building.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { canAccessProject, canAdministerProject } from '@/lib/edition/guard'
import {
  deleteSmtpConfig,
  getSmtpConfigView,
  saveSmtpConfig,
  validateSmtpConfig,
} from '@/lib/email/project-smtp'

export const GET = withAuth(async (_request: NextRequest, { user, params }) => {
  const { id: projectId } = await params
  if (!(await canAccessProject(user.userId, projectId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  // The view type has no field that could hold a password. Not "usually empty" —
  // the shape cannot carry one, so no later edit starts returning it by accident.
  return NextResponse.json({ smtp: await getSmtpConfigView(projectId) })
})

export const PUT = withAuth(async (request: NextRequest, { user, params }) => {
  const { id: projectId } = await params
  if (!(await canAdministerProject(user.userId, projectId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'A JSON body is required' }, { status: 400 })
  }

  const current = await getSmtpConfigView(projectId)
  const input = {
    host: String(body.host ?? ''),
    port: Number(body.port),
    username: String(body.username ?? ''),
    // Absent means keep the stored one. An empty string is NOT "keep": it is an
    // operator clearing the field, and storing an empty password would leave a
    // config that looks complete and cannot authenticate.
    password: typeof body.password === 'string' && body.password.length > 0 ? body.password : undefined,
    fromAddress: String(body.fromAddress ?? ''),
    fromName: typeof body.fromName === 'string' ? body.fromName : null,
    enabled: body.enabled !== false,
  }

  const problems = validateSmtpConfig(input, current.passwordConfigured)
  if (problems.length > 0) {
    return NextResponse.json({ error: 'These settings cannot be used', problems }, { status: 400 })
  }

  await saveSmtpConfig(projectId, input)

  // Returned with the test result cleared, because saving invalidated it.
  // Settings that changed have not been proven, and a stale green tick beside
  // new credentials is the false claim this row exists to avoid.
  return NextResponse.json({ smtp: await getSmtpConfigView(projectId) })
})

export const DELETE = withAuth(async (_request: NextRequest, { user, params }) => {
  const { id: projectId } = await params
  if (!(await canAdministerProject(user.userId, projectId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  const removed = await deleteSmtpConfig(projectId)
  // Deleting falls back to the deployment environment when one is configured,
  // and to logging when it is not. The view says which, so the operator is not
  // left guessing whether mail still sends.
  return NextResponse.json({ removed, smtp: await getSmtpConfigView(projectId) })
})

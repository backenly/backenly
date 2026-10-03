export const dynamic = 'force-dynamic'

/**
 * Send a real email through the project's SMTP settings and report what
 * happened.
 *
 * The whole reason this exists is that "configured" and "works" are different
 * claims. Every field can be right and the credentials still wrong, the port
 * still blocked, the sender still unverified with the provider. A dashboard that
 * shows a green tick for a stored row is asserting the second from the first.
 *
 * So this performs a real send through the same transport production uses, and
 * the answer describes the RESULT. A restore step in the recovery tranche
 * returned a cheerful string having restored nothing; that class of answer is
 * banned.
 */

import { NextRequest, NextResponse } from 'next/server'
import nodemailer from 'nodemailer'
import { withAuth } from '@/lib/auth/route-protection'
import { canAdministerProject } from '@/lib/edition/guard'
import { getSmtpConfigView, isTestRecipient, sendProjectSmtpTest } from '@/lib/email/project-smtp'

export const POST = withAuth(async (request: NextRequest, { user, params }) => {
  const { id: projectId } = await params

  // ADMIN, and a write: this sends live mail to an address the caller names,
  // through credentials that may be billed per message.
  if (!(await canAdministerProject(user.userId, projectId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  const body = await request.json().catch(() => null)
  if (!isTestRecipient(body?.to)) {
    return NextResponse.json(
      { error: 'A "to" address is required, so the test proves delivery somewhere you can check.' },
      { status: 400 },
    )
  }

  // Shared with the agent's auth test_smtp (lib/email/project-smtp.ts).
  const result = await sendProjectSmtpTest(nodemailer, projectId, body.to.trim())
  if (result.source === 'none') {
    return NextResponse.json(
      { success: false, error: result.error, smtp: await getSmtpConfigView(projectId) },
      // 400, not 500: nothing is broken. Nothing is configured.
      { status: 400 },
    )
  }

  return NextResponse.json({
    success: result.sent,
    source: result.source,
    ...(result.error ? { error: result.error } : {}),
    smtp: await getSmtpConfigView(projectId),
  })
})

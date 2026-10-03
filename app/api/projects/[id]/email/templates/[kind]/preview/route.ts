export const dynamic = 'force-dynamic'

/**
 * Render a candidate template with sample values, without storing it.
 *
 * ── The preview is the dangerous surface, not the email ─────────────────────
 *
 * An operator authors raw HTML here. In a mail client that is inert: no mail
 * client runs script. In the DASHBOARD it is markup rendered inside an
 * authenticated origin, which is where operator-authored HTML stops being
 * content and becomes a script-injection question.
 *
 * Two things answer it, and both are needed:
 *
 *   - `validateTemplate` refuses a <script> tag outright. No mail client would
 *     run it, so its only possible audience is this preview.
 *   - the response is DATA, and the client renders it in a sandboxed iframe with
 *     no allow-scripts and no allow-same-origin. Returning it as data means this
 *     route cannot be navigated to and rendered as a page in the dashboard's
 *     own origin.
 *
 * The substituted VALUES are HTML-escaped by `renderTemplate` regardless, so an
 * appName of `"><script>` cannot become markup in either place.
 *
 * ── Sample values, clearly fake ─────────────────────────────────────────────
 *
 * The preview must never carry a real token. The link is obviously an example,
 * so an operator cannot mistake the preview for a working email and click
 * through expecting it to do something.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { canWriteProject } from '@/lib/edition/guard'
import {
  isTemplateKind,
  renderSubject,
  renderTemplate,
  validateTemplate,
  type TemplateVariable,
} from '@/lib/email/template-kinds'
import { getAuthEmailContext } from '@/lib/services/end-user-auth-email'

const EXPIRY_BY_KIND: Record<string, string> = {
  verification: '24 hours',
  password_reset: '1 hour',
  magic_link: '15 minutes',
}

export const POST = withAuth(async (request: NextRequest, { user, params }) => {
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

  // Validated before rendering, so the preview cannot show something the save
  // would reject. A preview that works and a save that fails is a worse
  // experience than no preview.
  const errors = validateTemplate(subject, bodyHtml)
  if (errors.length > 0) {
    return NextResponse.json({ error: 'This template cannot be used', errors }, { status: 400 })
  }

  const ctx = await getAuthEmailContext(projectId)
  const values: Partial<Record<TemplateVariable, string>> = {
    appName: ctx.appName,
    email: 'end-user@example.com',
    // Obviously an example. Never a real token, which would make the preview a
    // way to mint a working link.
    ctaUrl: 'https://example.com/auth-link-goes-here',
    expiry: EXPIRY_BY_KIND[kind] ?? '1 hour',
  }

  return NextResponse.json({
    preview: {
      subject: renderSubject(subject, values),
      // Returned as data, for a sandboxed iframe. Not served as HTML.
      bodyHtml: renderTemplate(bodyHtml, values),
      values,
    },
  })
})

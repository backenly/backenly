import { NextRequest, NextResponse } from 'next/server'
import { verifySession } from '@/lib/auth/session'
import { canAccessProject, canWriteProject } from '@/lib/edition/guard'
import { getAuthEmailPolicy, saveAuthEmailPolicy } from '@/lib/services/auth-email-policy'

/**
 * GET/PUT /api/projects/[id]/auth-email-settings
 *
 * Per-project end-user auth email settings (ProjectAuthConfig): the app name
 * and URL used in verification / magic-link / password-reset emails, plus the
 * requireEmailVerification and magicLinksEnabled policy toggles. The agent's
 * auth tool writes the same settings through lib/services/auth-email-policy.
 */

/**
 * Authentication only: who is calling, or null.
 *
 * This used to be `authorize`, and it did three jobs at once — read the
 * session, check ownership, and hand back the project row — behind a single
 * null return. That made every failure indistinguishable, so an authenticated
 * member who simply lacked access was told "Unauthorized" with a 401, which
 * says re-authenticate when re-authenticating cannot help. Teaching that helper
 * about roles would have deepened the conflation rather than fixing it.
 *
 * Authentication, authorization and data retrieval are now three steps, in that
 * order, at each call site.
 */
async function authenticate(request: NextRequest): Promise<string | null> {
  const token = request.cookies.get('auth-token')?.value
  if (!token) return null
  const session = await verifySession(token)
  if (!session.valid || !session.userId) return null
  return session.userId
}

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const userId = await authenticate(request)
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (!(await canAccessProject(userId, params.id))) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // By id alone: the authorization question was already answered above.
    const settings = await getAuthEmailPolicy(params.id)
    if (!settings) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    return NextResponse.json({ success: true, settings })
  } catch (error: any) {
    console.error('[Auth Email Settings] GET failed:', error)
    return NextResponse.json({ error: 'Failed to load auth email settings' }, { status: 500 })
  }
}

export async function PUT(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const userId = await authenticate(request)
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    // No project row is needed here: PUT upserts ProjectAuthConfig by projectId
    // and never read the row it used to fetch.
    if (!(await canWriteProject(userId, params.id))) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const result = await saveAuthEmailPolicy(params.id, await request.json())
    if ('code' in result) {
      if ('problems' in result) {
        return NextResponse.json({ error: 'Validation failed', details: result.problems }, { status: 400 })
      }
      if (result.code === 'NO_EMAIL_SENDER') {
        return NextResponse.json({ error: result.message, code: result.code }, { status: 409 })
      }
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    return NextResponse.json({ success: true, settings: result.policy })
  } catch (error: any) {
    console.error('[Auth Email Settings] PUT failed:', error)
    return NextResponse.json({ error: 'Failed to save auth email settings' }, { status: 500 })
  }
}

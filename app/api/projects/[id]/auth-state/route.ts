import { NextRequest, NextResponse } from 'next/server'
import { getProjectAuthStatus } from '@/lib/services/auth-status'
import { withAuth } from '@/lib/auth/route-protection'
import { canAccessProject } from '@/lib/edition/guard'

/**
 * GET /api/projects/[projectId]/auth-state
 *
 * Auth provider status for the inspector. Delegates to the shared
 * getProjectAuthStatus resolver so this endpoint, the dashboard
 * (/api/projects/[id]/state), and the proof system always agree on
 * which providers are connected.
 */

/**
 * ── This route had NO authentication ────────────────────────────────────────
 *
 * It took a project id from the path and answered. Anyone able to reach the
 * server and name a project could read which auth providers a project has connected - without a session, let alone
 * ownership. Found by the route-authorization sweep; no UI called it, which is
 * why nothing ever noticed.
 *
 * A read is not harmless here: it discloses how somebody else's backend is
 * built. 404 rather than 403, so the endpoint is not an oracle for project ids.
 */
export const GET = withAuth(async (_request: NextRequest, { user, params: routeParams }) => {
  const params = await routeParams
  try {
    const projectId = params.id

    if (!(await canAccessProject(user.userId, projectId))) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    const status = await getProjectAuthStatus(projectId)

    const ICON: Record<string, string> = {
      email: 'Mail',
      google: 'Chrome',
      github: 'Github',
    }

    const providers = status.providers.map(p => ({
      id: p.id,
      name: p.id,
      enabled: p.enabled,
      configured: p.enabled,
      type: p.type,
      icon: ICON[p.id] ?? 'Shield',
      clientId: null,
      clientSecret: null,
      redirectUri: null,
      scopes: [] as string[],
    }))

    return NextResponse.json({
      success: true,
      providers,
    })
  } catch (error: any) {
    console.error('[Auth State API] Error:', error)
    return NextResponse.json(
      { error: 'Failed to load auth state', details: error?.message },
      { status: 500 }
    )
  }
})

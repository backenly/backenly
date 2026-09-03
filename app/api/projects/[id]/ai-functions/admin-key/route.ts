import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth/middleware'
import { getProjectAdminKey } from '@/lib/services/ai-functions/project-fn-auth'
import { canAccessProject } from '@/lib/edition/guard'

/**
 * GET /api/projects/[id]/ai-functions/admin-key
 *
 * Returns the project's admin API key for x-admin-key gated business
 * endpoints (admin-users-list, admin-usage-dashboard, admin-impersonate, ...).
 *
 * The key is derived from the project's jwtSecret (HMAC), so it is unique per
 * project, needs no storage, and rotates automatically with the jwtSecret.
 * Owner-only: this key grants admin access to the project's OWN workspace
 * data — never to anything platform-level.
 */
export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticateRequest(request)
    if (!auth.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    if (!(await canAccessProject(auth.userId, params.id))) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    const adminKey = await getProjectAdminKey(params.id)

    return NextResponse.json({
      adminKey,
      header: 'x-admin-key',
      usage: `curl -H "x-api-key: <your public API key>" -H "x-admin-key: ${adminKey}" https://backenly.com/api/v1/${params.id}/fn/<function-name>`,
    })
  } catch (error: any) {
    console.error('[AI Functions] admin-key error:', error)
    return NextResponse.json({ error: 'Failed to resolve admin key' }, { status: 500 })
  }
}

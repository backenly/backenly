export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { enableAuth } from '@/lib/services/workspaceAuth'
import { emit } from '@/lib/events/bus'

/**
 * POST /api/auth/enable — Enable authentication for a project
 * Automatically creates User model and runs migrations.
 * Emits schema.changed after success so the inspector refreshes without a browser reload.
 */
export const POST = withProjectAccess(async (request: NextRequest, { projectId, user }) => {
  try {
    const result = await enableAuth(projectId)

    if (!result.success) {
      return NextResponse.json({ error: result.message }, { status: 400 })
    }

    // Notify the event bus so all UI listeners (inspector, dashboard) refresh state
    emit('schema.changed', projectId, { source: 'auth', action: 'enable_auth' })

    return NextResponse.json({ message: result.message, success: true })
  } catch (error: any) {
    console.error('Enable auth error:', error)
    return NextResponse.json({ error: 'Failed to enable authentication' }, { status: 500 })
  }
})

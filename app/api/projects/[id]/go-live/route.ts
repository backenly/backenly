import { NextRequest, NextResponse } from 'next/server'
import { getProjectContext, UnauthorizedError, ForbiddenError } from '@/lib/auth/server'
import { goLive } from '@/lib/deployment/go-live'
import { markDeployed } from '@/lib/analytics/logger'
import { sanitizeDiagnostic } from '@/lib/errors/diagnostic-sanitize'

/**
 * POST /api/projects/:id/go-live
 *
 * One-Click "Make It Live" System
 * - First publish: PRIVATE -> DEPLOYING -> LIVE (creates v1)
 * - Subsequent: Creates new versioned deployment snapshot (v2, v3, ...)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const projectId = params.id
    const { user } = await getProjectContext(projectId)

    // UI button click is its own confirmation — pass force:true so the engine
    // skips the "Type DEPLOY" second-layer prompt (that's for the chat path).
    const result = await goLive(projectId, user.userId, { confirmedBy: 'UI', force: true })

    if (result.kind === 'error') {
      // Readiness-blocked deploys get a structured payload so the UI can show
      // a clean one-line error and refresh its readiness panel, instead of the
      // markdown blob meant for the chat path.
      if (result.readinessReport) {
        const n = result.readinessReport.blockers.length
        return NextResponse.json(
          {
            success: false,
            error: `Publish blocked — ${n} readiness issue${n === 1 ? '' : 's'} must be cleared first. Details are in the readiness panel.`,
            readiness: result.readinessReport,
          },
          { status: 422 }
        )
      }
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.error === 'Project not found' ? 404 : 500 }
      )
    }

    // Confirmation result is impossible here (force:true) but TS needs the narrowing.
    if (result.kind === 'confirmation') {
      return NextResponse.json({ success: false, error: 'Unexpected confirmation gate on UI deploy' }, { status: 500 })
    }

    // Track deployment event (non-blocking)
    markDeployed(projectId, user.userId)

    return NextResponse.json({
      success: true,
      publicUrl: result.publicUrl,
      version: result.version,
      noChanges: result.noChanges === true,
      message: result.noChanges
        ? `Already up to date — v${result.version} is the latest`
        : result.alreadyLive
        ? `Published v${result.version} successfully`
        : 'Your backend is now live',
    })
  } catch (error: any) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ success: false, error: 'Authentication required' }, { status: 401 })
    }
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ success: false, error: 'Project not found or access denied' }, { status: 404 })
    }
    console.error('[GO_LIVE] Error:', error)
    const safe = sanitizeDiagnostic(error)
    return NextResponse.json(
      { success: false, error: safe || 'Failed to initiate deployment' },
      { status: 500 }
    )
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth/jwt'
import { runBackgroundAgent } from '@/lib/ai/background-agent'

/**
 * GET /api/projects/[id]/ai-suggestions
 * Run the background audit agent and return findings.
 * Called by the sidebar on project load to surface proactive suggestions.
 */
export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const sessionToken = request.cookies.get('auth-token')?.value
    const authHeader = request.headers.get('authorization')
    const token = sessionToken || authHeader?.replace('Bearer ', '')

    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    await verifyToken(token)
    const projectId = params.id

    const result = await runBackgroundAgent(projectId)

    return NextResponse.json({
      success: true,
      projectId,
      findings: result.findings,
      autoFixed: result.autoFixed,
      checkedAt: result.checkedAt,
      summary: {
        critical: result.findings.filter(f => f.severity === 'critical').length,
        warning: result.findings.filter(f => f.severity === 'warning').length,
        info: result.findings.filter(f => f.severity === 'info').length,
        total: result.findings.length,
      },
    })
  } catch (error: any) {
    console.error('[AI Suggestions API] Error:', error)
    return NextResponse.json(
      { error: 'Failed to run background audit' },
      { status: 500 }
    )
  }
}

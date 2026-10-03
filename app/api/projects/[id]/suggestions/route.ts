export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getActiveSuggestions } from '@/lib/suggestions'
import { verifyToken } from '@/lib/auth/jwt'
import { canAccessProject } from '@/lib/edition/guard'

/**
 * GET /api/projects/[projectId]/suggestions
 * 
 * Returns active suggestions for the current graph version.
 * Suggestions are non-mutating, advisory-only analysis.
 */
export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    // Authenticate
    const sessionToken = request.cookies.get('auth-token')?.value
    if (!sessionToken) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      )
    }

    const decoded = await verifyToken(sessionToken)
    const callerId = decoded.userId
    const userId = decoded.userId
    const projectId = params.id

    // Ownership. verifyToken answers "who is this"; it does not answer "may
    // they read this project". The result was not even captured here, so the
    // project id from the path went straight through unchecked.
    // 404 rather than 403 so the endpoint is not an oracle for project ids.
    if (!(await canAccessProject(callerId, projectId))) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }


    // Verify project access (implicit via getActiveSuggestions)
    const suggestions = await getActiveSuggestions(projectId)
    
    // Count by severity
    const counts = {
      high: suggestions.filter(s => s.severity === 'high').length,
      medium: suggestions.filter(s => s.severity === 'medium').length,
      low: suggestions.filter(s => s.severity === 'low').length,
    }

    return NextResponse.json({
      success: true,
      suggestions,
      counts,
      total: suggestions.length,
    })

  } catch (error) {
    console.error('[Suggestions API] Error:', error)
    return NextResponse.json(
      { error: 'Failed to load suggestions' },
      { status: 500 }
    )
  }
}

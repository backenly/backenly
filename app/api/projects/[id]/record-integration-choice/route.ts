/**
 * Record Integration Choice API
 * 
 * Records user's architectural integration choice for learning
 */

import { NextRequest, NextResponse } from 'next/server'
import { recordIntegrationChoice } from '@/lib/architecture-memory'
import { verifyToken } from '@/lib/auth/jwt'
import { canWriteProject } from '@/lib/edition/guard'

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    // Authenticate
    const sessionToken = request.cookies.get('auth-token')?.value
    if (!sessionToken) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const decoded = await verifyToken(sessionToken)
    const userId = decoded.userId
    const projectId = params.id

    // Verify project ownership
    if (!(await canWriteProject(userId, projectId))) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    // Get request body
    const body = await request.json()
    const { scenario, optionId, optionTitle } = body

    if (!scenario || !optionId || !optionTitle) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      )
    }

    // Record the choice
    await recordIntegrationChoice(
      projectId,
      scenario,
      optionId,
      optionTitle
    )

    return NextResponse.json({
      success: true,
      message: 'Integration choice recorded',
    })

  } catch (error: any) {
    console.error('[Record Integration Choice] Error:', error)
    return NextResponse.json(
      { error: 'Failed to record choice' },
      { status: 500 }
    )
  }
}

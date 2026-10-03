export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth/middleware'
import { canAccessProject } from '@/lib/edition/guard'
import { generateDiffPreview, type BackendChangePlan } from '@/lib/services/aiWorkspace'

// POST /api/ai-workspace/preview-diff - Preview diffs for a change plan
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticateRequest(request)
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { plan, projectId } = body

    if (!plan) {
      return NextResponse.json(
        { error: 'Plan is required' },
        { status: 400 }
      )
    }

    // Ownership, before the project id reaches anything that reads it.
    //
    // This route authenticated the caller and then took `projectId` straight
    // from the request body. Authentication answers who is asking; it says
    // nothing about which project they may read the schema of.
    if (!projectId) {
      return NextResponse.json({ error: 'Project ID is required' }, { status: 400 })
    }
    if (!(await canAccessProject(auth.userId, projectId))) {
      // 404, not 403: the endpoint must not confirm which project ids exist.
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const diffs = await generateDiffPreview(plan as BackendChangePlan, projectId)

    return NextResponse.json({ diffs })
  } catch (error: any) {
    console.error('Failed to generate diff preview:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to generate diff preview' },
      { status: 500 }
    )
  }
}


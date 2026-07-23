export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth/middleware'
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


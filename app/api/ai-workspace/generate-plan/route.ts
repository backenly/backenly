export const dynamic = 'force-dynamic'

// Increase timeout for AI generation (5 minutes)
export const maxDuration = 300

import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth/middleware'
import { canAccessProject } from '@/lib/edition/guard'
import { aiAvailability } from '@/lib/ai/llm'
import { generateBackendChangePlan } from '@/lib/services/aiWorkspace'

// POST /api/ai-workspace/generate-plan — Generate a backend change plan using AI
//
// The plan is written through the AI gateway (lib/ai/llm), so it fails with 503
// when the gateway has no provider configured, whichever provider that is.
// There is no demo fallback — returning fabricated plans to users is a trust violation.
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticateRequest(request)
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { prompt, projectId } = body

    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 })
    }

    // Ownership, before the project id reaches anything that reads it.
    //
    // This route authenticated the caller and then took `projectId` straight
    // from the request body. Authentication answers who is asking; it says
    // nothing about which project they may plan changes against.
    if (!projectId) {
      return NextResponse.json({ error: 'Project ID is required' }, { status: 400 })
    }
    if (!(await canAccessProject(auth.userId, projectId))) {
      // 404, not 403: the endpoint must not confirm which project ids exist.
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const ai = aiAvailability()
    if ('reason' in ai) {
      console.error('[generate-plan] No AI provider is available:', ai.reason)
      return NextResponse.json(
        { error: 'AI plan generation is temporarily unavailable. Please try again later.' },
        { status: 503 },
      )
    }

    const plan = await generateBackendChangePlan(prompt, projectId)
    return NextResponse.json({ plan })
  } catch (error: any) {
    console.error('[generate-plan] Failed:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to generate plan' },
      { status: 500 },
    )
  }
}

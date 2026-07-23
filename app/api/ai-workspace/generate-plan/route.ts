export const dynamic = 'force-dynamic'

// Increase timeout for AI generation (5 minutes)
export const maxDuration = 300

import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth/middleware'
import { generateBackendChangePlan } from '@/lib/services/aiWorkspace'

// POST /api/ai-workspace/generate-plan — Generate a backend change plan using AI
//
// Fails with 503 if OPENAI_API_KEY is not configured.
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

    if (!process.env.OPENAI_API_KEY) {
      console.error('[generate-plan] OPENAI_API_KEY is not configured')
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

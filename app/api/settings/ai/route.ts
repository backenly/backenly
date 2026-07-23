export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { getAiConfiguration, updateAiConfiguration } from '@/lib/services/aiConfig'

/**
 * GET /api/settings/ai - Get AI configuration
 * 🔒 Protected: Requires authentication and project ownership
 */
export const GET = withProjectAccess(async (request: NextRequest, { projectId, user }) => {
  try {
    const config = await getAiConfiguration(projectId)

    return NextResponse.json({ config })
  } catch (error: any) {
    console.error('Failed to get AI configuration:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to get AI configuration' },
      { status: 500 }
    )
  }
});

/**
 * PUT /api/settings/ai - Update AI configuration
 * 🔒 Protected: Requires authentication and project ownership
 */
export const PUT = withProjectAccess(async (request: NextRequest, { projectId, user }) => {
  try {
    const body = await request.json()
    const { model, temperature, maxTokens, systemPrompt, config } = body

    const updatedConfig = await updateAiConfiguration(projectId, {
      model,
      temperature,
      maxTokens,
      systemPrompt,
      config,
    })

    return NextResponse.json({ config: updatedConfig })
  } catch (error: any) {
    console.error('Failed to update AI configuration:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to update AI configuration' },
      { status: 500 }
    )
  }
});


export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { v1ApiMiddleware, requirePermission, requireCapability } from '@/lib/api/v1/middleware'
import { createErrorResponse, createSuccessResponse, handleValidationError, ErrorCodes } from '@/lib/api/v1/errors'
import { aiGenerateSchema } from '@/lib/api/v1/schemas'
import { validateRequestBody } from '@/lib/validation/schemas'
import OpenAI from 'openai'

/**
 * POST /v1/{projectId}/ai/generate
 * Generate content using AI
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string } }
) {
  try {
    const middleware = await v1ApiMiddleware(request, params)
    if (middleware.response) {
      return middleware.response
    }

    const { context } = middleware

    // AI actions require 'ai-only' or 'admin' permission
    const permissionCheck = requirePermission(context, ['ai-only', 'admin'])
    if (permissionCheck) {
      return permissionCheck
    }

    const capabilityCheck = requireCapability(context, request.nextUrl.pathname)
    if (capabilityCheck) {
      return capabilityCheck
    }

    const validation = await validateRequestBody(aiGenerateSchema, request)
    if (!validation.success) {
      return handleValidationError((validation as { success: false; error: string; status: number }).error as any)
    }

    const { prompt, model, temperature, maxTokens } = validation.data

    // Initialize OpenAI client
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    })

    // Generate content
    const completion = await openai.chat.completions.create({
      model: model || 'gpt-4.1',
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: temperature || 0.7,
      max_tokens: maxTokens || 1000,
    })

    const content = completion.choices[0]?.message?.content || ''

    return createSuccessResponse({
      content,
      model: completion.model,
      usage: {
        promptTokens: completion.usage?.prompt_tokens || 0,
        completionTokens: completion.usage?.completion_tokens || 0,
        totalTokens: completion.usage?.total_tokens || 0,
      },
    })
  } catch (error: any) {
    console.error('AI generate error:', error)
    return createErrorResponse(
      ErrorCodes.INTERNAL_ERROR,
      'Failed to generate content',
      500
    )
  }
}


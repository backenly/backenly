export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { executePlan, ExecutionResult } from '@/lib/ai/execution-engine'
import { enforceAiExecuteRateLimit, getRateLimitHeaders } from '@/lib/middleware/rateLimiter'

/**
 * Execute AI-generated plan
 * POST /api/ai/execute?projectId=xxx
 */
export async function POST(request: NextRequest) {
  return withProjectValidation<any>(request, async (validated) => {
    const { projectId, userId } = validated

    // 🛡️ Rate limit: 10 AI execute requests per user per minute (DB-backed, multi-instance safe)
    const rl = await enforceAiExecuteRateLimit(userId, projectId)
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'Too many execution requests. Please wait before retrying.' },
        { status: 429, headers: getRateLimitHeaders(rl) }
      )
    }

    try {
      const body = await request.json()
      const { plan, confirmation } = body

      if (!plan || !Array.isArray(plan) || plan.length === 0) {
        return NextResponse.json(
          { error: 'Plan is required and must be a non-empty array' },
          { status: 400 }
        )
      }

      console.log(`⚡ EXECUTING PLAN for project: ${projectId}`)
      console.log(`📋 Steps: ${plan.length}`)
      console.log(`✅ User confirmed: ${confirmation || 'auto'}`)

      // Execute the plan
      const result: ExecutionResult = await executePlan(plan, projectId)

      if (result.success) {
        console.log(`✅ Execution completed successfully`)
        console.log(`📁 Files created: ${result.filesCreated?.length || 0}`)
        console.log(`📝 Files modified: ${result.filesModified?.length || 0}`)
        console.log(`⚙️ Commands run: ${result.commandsRun?.length || 0}`)
      } else {
        console.error(`❌ Execution failed:`, result.errors)
      }

      return NextResponse.json({
        success: result.success,
        message: result.message,
        filesCreated: result.filesCreated,
        filesModified: result.filesModified,
        commandsRun: result.commandsRun,
        errors: result.errors,
        output: result.output,
      })
    } catch (error: any) {
      console.error('❌ Execution Error:', error)

      return NextResponse.json(
        {
          success: false,
          error: 'Execution failed',
          message: error.message || 'An unexpected error occurred',
        },
        { status: 500 }
      )
    }
  })
}

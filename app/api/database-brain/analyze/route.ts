export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { DatabaseBrain } from '@/lib/services/databaseBrain'
import { getCurrentProjectId } from '@/lib/tenant/isolation'
import { requireAuth } from '@/lib/auth/middleware'

// POST /api/database-brain/analyze - Run project-scoped analysis
export async function POST(request: NextRequest) {
  const requestId = `analyze-${Date.now()}`
  console.log(`🔵 [${requestId}] === ANALYSIS REQUEST START ===`)
  
  try {
    // Require authentication
    console.log(`🔐 [${requestId}] Authenticating request...`)
    const user = await requireAuth(request)
    console.log(`✅ [${requestId}] User authenticated: ${user.userId}`)
    
    const body = await request.json()
    const { mode = 'safe' } = body
    console.log(`⚙️ [${requestId}] Analysis mode: ${mode}`)

    // CRITICAL: Get project ID from tenant isolation (never trust client)
    console.log(`🎯 [${requestId}] Getting current project ID...`)
    const projectId = await getCurrentProjectId(request)
    
    if (!projectId) {
      console.error(`❌ [${requestId}] No project selected`)
      return NextResponse.json(
        {
          success: false,
          error: 'No project selected. Please select a project first.',
        },
        { status: 400 }
      )
    }
    
    console.log(`✅ [${requestId}] Project ID: ${projectId}`)
    console.log(`🔍 [${requestId}] Running ${mode} analysis for project: ${projectId}`)

    // Run project-scoped analysis
    const startTime = Date.now()
    const issues = await DatabaseBrain.runAnalysis({
      projectId,
      mode,
      userId: user.userId,
    })
    const duration = Date.now() - startTime
    
    console.log(`✅ [${requestId}] Analysis complete in ${duration}ms`)
    console.log(`📊 [${requestId}] Found ${issues.length} issues`)

    // Save issues to database (project-scoped)
    console.log(`💾 [${requestId}] Saving ${issues.length} issues to database...`)
    await DatabaseBrain.saveIssues(issues, projectId)
    console.log(`✅ [${requestId}] Issues saved successfully`)
    
    console.log(`🟢 [${requestId}] === ANALYSIS REQUEST COMPLETE ===`)

    return NextResponse.json({
      success: true,
      data: {
        issuesFound: issues.length,
        issues,
        projectId, // Return for verification
        mode,
      },
    })
  } catch (error: any) {
    console.error(`🔴 [${requestId}] === ANALYSIS REQUEST FAILED ===`)
    console.error(`❌ [${requestId}] Error Type: ${error.constructor.name}`)
    console.error(`❌ [${requestId}] Error Message: ${error.message}`)
    console.error(`❌ [${requestId}] Error Stack:`, error.stack?.split('\n').slice(0, 10).join('\n'))
    
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to run analysis',
        message: error.message,
        details: process.env.NODE_ENV === 'development' ? {
          type: error.constructor.name,
          stack: error.stack?.split('\n').slice(0, 5)
        } : undefined
      },
      { status: 500 }
    )
  }
}


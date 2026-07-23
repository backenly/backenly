export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { getCurrentProjectId } from '@/lib/tenant/isolation'
import { requireAuth } from '@/lib/auth/middleware'

// GET /api/database-brain/issues/[id] - Get issue details (project-scoped)
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const requestId = `issue-get-${Date.now()}`
  console.log(`🔵 [${requestId}] === GET ISSUE DETAILS REQUEST START ===`)
  console.log(`🎯 [${requestId}] Issue ID: ${params.id}`)
  
  try {
    // Require authentication
    console.log(`🔐 [${requestId}] Authenticating request...`)
    const user = await requireAuth(request)
    console.log(`✅ [${requestId}] User authenticated: ${user.userId}`)
    
    // CRITICAL: Get project ID from tenant isolation
    console.log(`🎯 [${requestId}] Getting current project ID...`)
    const projectId = await getCurrentProjectId(request)
    
    if (!projectId) {
      console.error(`❌ [${requestId}] No project selected`)
      return NextResponse.json(
        { success: false, error: 'No project selected' },
        { status: 400 }
      )
    }
    
    console.log(`✅ [${requestId}] Project ID: ${projectId}`)
    console.log(`🔍 [${requestId}] Fetching issue ${params.id} for project ${projectId}...`)

    // SECURITY: Verify issue belongs to current project
    const startTime = Date.now()
    const issue = await prisma.databaseIssue.findFirst({
      where: { 
        id: params.id,
        projectId, // CRITICAL: Project scope filter
      },
    })
    const duration = Date.now() - startTime

    if (!issue) {
      console.error(`❌ [${requestId}] Issue not found or access denied (query took ${duration}ms)`)
      return NextResponse.json(
        {
          success: false,
          error: 'Issue not found or access denied',
        },
        { status: 404 }
      )
    }
    
    console.log(`✅ [${requestId}] Issue found in ${duration}ms`)
    console.log(`🟢 [${requestId}] === GET ISSUE DETAILS REQUEST COMPLETE ===`)

    return NextResponse.json({
      success: true,
      data: issue,
    })
  } catch (error: any) {
    console.error(`🔴 [${requestId}] === GET ISSUE DETAILS REQUEST FAILED ===`)
    console.error(`❌ [${requestId}] Error Type: ${error.constructor.name}`)
    console.error(`❌ [${requestId}] Error Message: ${error.message}`)
    console.error(`❌ [${requestId}] Error Stack:`, error.stack?.split('\n').slice(0, 10).join('\n'))
    
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch issue',
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

// PUT /api/database-brain/issues/[id] - Update issue (project-scoped)
export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const requestId = `issue-update-${Date.now()}`
  console.log(`🔵 [${requestId}] === UPDATE ISSUE REQUEST START ===`)
  console.log(`🎯 [${requestId}] Issue ID: ${params.id}`)
  
  try {
    // Require authentication
    console.log(`🔐 [${requestId}] Authenticating request...`)
    const user = await requireAuth(request)
    console.log(`✅ [${requestId}] User authenticated: ${user.userId}`)
    
    // CRITICAL: Get project ID from tenant isolation
    console.log(`🎯 [${requestId}] Getting current project ID...`)
    const projectId = await getCurrentProjectId(request)
    
    if (!projectId) {
      console.error(`❌ [${requestId}] No project selected`)
      return NextResponse.json(
        { success: false, error: 'No project selected' },
        { status: 400 }
      )
    }
    
    console.log(`✅ [${requestId}] Project ID: ${projectId}`)

    // SECURITY: Verify issue belongs to current project before update
    console.log(`🔍 [${requestId}] Verifying issue ownership...`)
    const existingIssue = await prisma.databaseIssue.findFirst({
      where: { 
        id: params.id,
        projectId, // CRITICAL: Project scope filter
      },
    })

    if (!existingIssue) {
      console.error(`❌ [${requestId}] Issue not found or access denied`)
      return NextResponse.json(
        {
          success: false,
          error: 'Issue not found or access denied',
        },
        { status: 404 }
      )
    }
    
    console.log(`✅ [${requestId}] Issue ownership verified`)

    const body = await request.json()
    const { status, sqlFix, migrationSteps } = body
    console.log(`📝 [${requestId}] Update data:`, { status, hasSqlFix: !!sqlFix, hasMigrationSteps: !!migrationSteps })

    const updateData: any = {}
    if (status) {
      updateData.status = status
      if (status === 'resolved') {
        updateData.resolvedAt = new Date()
      }
    }
    if (sqlFix) updateData.sqlFix = sqlFix
    if (migrationSteps) updateData.migrationSteps = migrationSteps
    
    console.log(`💾 [${requestId}] Updating issue in database...`)
    const startTime = Date.now()
    const issue = await prisma.databaseIssue.update({
      where: { id: params.id },
      data: updateData,
    })
    const duration = Date.now() - startTime
    
    console.log(`✅ [${requestId}] Issue updated in ${duration}ms`)
    console.log(`🟢 [${requestId}] === UPDATE ISSUE REQUEST COMPLETE ===`)

    return NextResponse.json({
      success: true,
      data: issue,
    })
  } catch (error: any) {
    console.error(`🔴 [${requestId}] === UPDATE ISSUE REQUEST FAILED ===`)
    console.error(`❌ [${requestId}] Error Type: ${error.constructor.name}`)
    console.error(`❌ [${requestId}] Error Message: ${error.message}`)
    console.error(`❌ [${requestId}] Error Stack:`, error.stack?.split('\n').slice(0, 10).join('\n'))
    
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to update issue',
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


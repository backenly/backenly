export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { z } from 'zod'
import { getCurrentProjectId } from '@/lib/tenant/isolation'
import { requireAuth } from '@/lib/auth/middleware'

const querySchema = z.object({
  severity: z.enum(['high', 'medium', 'low', 'info']).optional(),
  database: z.string().optional(),
  status: z.enum(['open', 'resolved', 'ignored']).optional(),
})

// GET /api/database-brain/issues - List issues for current project ONLY
export async function GET(request: NextRequest) {
  const requestId = `issues-list-${Date.now()}`
  console.log(`🔵 [${requestId}] === GET ISSUES REQUEST START ===`)
  
  try {
    // Require authentication
    console.log(`🔐 [${requestId}] Authenticating request...`)
    const user = await requireAuth(request)
    console.log(`✅ [${requestId}] User authenticated: ${user.userId}`)
    
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

    const searchParams = request.nextUrl.searchParams
    const validated = querySchema.parse({
      severity: searchParams.get('severity') || undefined,
      database: searchParams.get('database') || undefined,
      status: searchParams.get('status') || undefined,
    })
    
    console.log(`🔍 [${requestId}] Query filters:`, validated)

    // SECURITY: Always filter by current project
    const where: any = { projectId }
    if (validated.severity) where.severity = validated.severity
    if (validated.database) where.database = validated.database
    if (validated.status) where.status = validated.status
    
    console.log(`💾 [${requestId}] Querying database with filters:`, where)

    const startTime = Date.now()
    const issues = await prisma.databaseIssue.findMany({
      where,
      orderBy: [
        { severity: 'asc' }, // high, medium, low, info
        { createdAt: 'desc' },
      ],
    })
    const duration = Date.now() - startTime
    
    console.log(`✅ [${requestId}] Query completed in ${duration}ms`)
    console.log(`📊 [${requestId}] Found ${issues.length} issues for project ${projectId}`)
    console.log(`🟢 [${requestId}] === GET ISSUES REQUEST COMPLETE ===`)

    return NextResponse.json({
      success: true,
      data: issues,
      count: issues.length,
      projectId, // Return for verification
    })
  } catch (error: any) {
    console.error(`🔴 [${requestId}] === GET ISSUES REQUEST FAILED ===`)
    console.error(`❌ [${requestId}] Error Type: ${error.constructor.name}`)
    console.error(`❌ [${requestId}] Error Message: ${error.message}`)
    console.error(`❌ [${requestId}] Error Stack:`, error.stack?.split('\n').slice(0, 10).join('\n'))
    
    if (error instanceof z.ZodError) {
      console.error(`⚠️ [${requestId}] Validation errors:`, error.errors)
      return NextResponse.json(
        {
          success: false,
          error: 'Validation error',
          details: error.errors,
        },
        { status: 400 }
      )
    }

    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch issues',
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


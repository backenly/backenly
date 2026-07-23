export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/middleware'
import { getCurrentProjectId } from '@/lib/tenant/isolation'
import { prisma } from '@/lib/db'
import { getMongoDB } from '@/lib/db'

/**
 * AUTO-APPLY FIX - One-Click Database Optimization
 * 
 * This is the magic that makes it a true BaaS platform!
 * Users don't need to know SQL - we handle it automatically.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const requestId = `apply-fix-${Date.now()}`
  console.log(`🔵 [${requestId}] === AUTO-APPLY FIX REQUEST START ===`)

  try {
    // Authenticate user
    console.log(`🔐 [${requestId}] Authenticating request...`)
    const user = await requireAuth(request)
    console.log(`✅ [${requestId}] User authenticated: ${user.userId}`)

    // Get current project ID
    console.log(`🎯 [${requestId}] Getting current project ID...`)
    const projectId = await getCurrentProjectId(request)
    console.log(`✅ [${requestId}] Project ID: ${projectId}`)

    const { id } = params

    // Get the issue
    console.log(`🔍 [${requestId}] Fetching issue: ${id}`)
    const issue = await prisma.databaseIssue.findUnique({
      where: { id },
    })

    if (!issue) {
      console.error(`❌ [${requestId}] Issue not found: ${id}`)
      return NextResponse.json(
        { success: false, error: 'Issue not found' },
        { status: 404 }
      )
    }

    // SECURITY: Verify issue belongs to current project
    if (issue.projectId !== projectId) {
      console.error(`❌ [${requestId}] Unauthorized: Issue belongs to different project`)
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 403 }
      )
    }

    // Check if SQL fix is available
    if (!issue.sqlFix) {
      console.error(`❌ [${requestId}] No SQL fix available for issue: ${id}`)
      return NextResponse.json(
        { success: false, error: 'No SQL fix available. Generate a fix first.' },
        { status: 400 }
      )
    }

    console.log('[' + requestId + '] Executing SQL fix...')
    console.log('[' + requestId + '] SQL: ' + issue.sqlFix)

    const startTime = Date.now()
    let executionResult: {
      executed: boolean
      rowsAffected?: number
      duration: number
      error?: string
    } = {
      executed: false,
      rowsAffected: 0,
      duration: 0,
    }

    try {
      // Execute the SQL fix based on database type
      if (issue.database === 'postgresql') {
        console.log(`🐘 [${requestId}] Executing PostgreSQL fix...`)
        
        // Execute raw SQL using Prisma
        const result = await prisma.$executeRawUnsafe(issue.sqlFix)
        
        executionResult = {
          executed: true,
          rowsAffected: result,
          duration: Date.now() - startTime,
        }
        
        console.log(`✅ [${requestId}] PostgreSQL fix executed successfully`)
        console.log(`📊 [${requestId}] Rows affected: ${result}`)
      } else if (issue.database === 'mongodb') {
        console.log(`🍃 [${requestId}] Executing MongoDB fix...`)
        
        const db = await getMongoDB()
        if (!db) {
          throw new Error('MongoDB connection not available')
        }

        // Parse and execute MongoDB command
        // (MongoDB fixes are typically index creation commands)
        const mongoCommand = JSON.parse(issue.sqlFix)
        const result = await db.command(mongoCommand)
        
        executionResult = {
          executed: true,
          rowsAffected: 1,
          duration: Date.now() - startTime,
        }
        
        console.log(`✅ [${requestId}] MongoDB fix executed successfully`)
      } else {
        throw new Error(`Unsupported database type: ${issue.database}`)
      }
    } catch (sqlError: any) {
      console.error(`❌ [${requestId}] SQL execution failed:`, sqlError)
      executionResult = {
        executed: false,
        duration: Date.now() - startTime,
        error: sqlError.message,
      }
      
      return NextResponse.json(
        {
          success: false,
          error: `Failed to execute fix: ${sqlError.message}`,
          data: { executionResult },
        },
        { status: 500 }
      )
    }

    // Mark issue as resolved
    console.log(`✓ [${requestId}] Marking issue as resolved...`)
    const updatedIssue = await prisma.databaseIssue.update({
      where: { id },
      data: {
        status: 'resolved',
        resolvedAt: new Date(),
      },
    })

    console.log(`✅ [${requestId}] Issue marked as resolved`)
    console.log(`🟢 [${requestId}] === AUTO-APPLY FIX REQUEST COMPLETE ===`)
    console.log(`⏱️  [${requestId}] Total duration: ${Date.now() - startTime}ms`)

    return NextResponse.json({
      success: true,
      data: {
        issue: updatedIssue,
        executionResult,
      },
    })
  } catch (error: any) {
    console.error(`🔴 [${requestId}] === AUTO-APPLY FIX REQUEST FAILED ===`)
    console.error(`❌ [${requestId}] Error Type: ${error.constructor.name}`)
    console.error(`❌ [${requestId}] Error Message: ${error.message}`)
    console.error(`❌ [${requestId}] Stack:`, error.stack?.split('\n').slice(0, 10).join('\n'))

    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Failed to apply fix',
        ...(process.env.NODE_ENV === 'development' && {
          details: {
            type: error.constructor.name,
            message: error.message,
            stack: error.stack?.split('\n').slice(0, 5),
          },
        }),
      },
      { status: 500 }
    )
  }
}

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { getJournal, getProjectJournals, rollbackExecution } from '@/lib/ai/execution-journal'

/**
 * OBSERVABILITY API: Execution Journals
 * 
 * GET /api/ai/journal?projectId=xxx - List all journals
 * GET /api/ai/journal?journalId=xxx - Get specific journal
 * POST /api/ai/journal/rollback - Rollback execution
 */

export async function GET(request: NextRequest) {
  return withProjectValidation<any>(request, async (validated) => {
    const { projectId } = validated
    const { searchParams } = new URL(request.url)
    const journalId = searchParams.get('journalId')

    if (journalId) {
      // Get specific journal
      const journal = await getJournal(journalId)
      
      if (!journal) {
        return NextResponse.json(
          { error: 'Journal not found' },
          { status: 404 }
        )
      }
      
      if (journal.projectId !== projectId) {
        return NextResponse.json(
          { error: 'Access denied' },
          { status: 403 }
        )
      }

      return NextResponse.json({
        journal,
        summary: {
          totalSteps: journal.totalSteps,
          completedSteps: journal.entries.filter(e => e.status === 'success').length,
          failedSteps: journal.entries.filter(e => e.status === 'failed').length,
          duration: journal.endTime 
            ? journal.endTime.getTime() - journal.startTime.getTime()
            : Date.now() - journal.startTime.getTime(),
        },
      })
    }

    // List all journals for project
    const journals = await getProjectJournals(projectId)

    return NextResponse.json({
      journals: journals.map(j => ({
        id: j.id,
        planDescription: j.planDescription,
        status: j.status,
        totalSteps: j.totalSteps,
        currentStep: j.currentStep,
        startTime: j.startTime,
        endTime: j.endTime,
        duration: j.endTime 
          ? j.endTime.getTime() - j.startTime.getTime()
          : undefined,
      })),
      count: journals.length,
    })
  })
}

// Rollback execution
export async function POST(request: NextRequest) {
  return withProjectValidation<any>(request, async (validated) => {
    const { projectId } = validated
    const body = await request.json()
    const { journalId } = body

    if (!journalId) {
      return NextResponse.json(
        { error: 'journalId is required' },
        { status: 400 }
      )
    }

    // Verify journal belongs to project
    const journal = await getJournal(journalId)
    if (!journal || journal.projectId !== projectId) {
      return NextResponse.json(
        { error: 'Journal not found or access denied' },
        { status: 404 }
      )
    }

    console.log(`🔄 Rolling back execution: ${journalId}`)

    const result = await rollbackExecution(journalId)

    return NextResponse.json({
      success: result.success,
      message: result.message,
      rolledBack: result.rolledBack,
      failed: result.failed,
    })
  })
}

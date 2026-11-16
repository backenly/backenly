/**
 * GET /api/projects/:id/ai-functions/logs
 * Returns execution logs for all AI functions in a project.
 * Supports ?functionId=xxx to filter to a single function, and ?success=false
 * (or true) to filter by outcome on the server: the route returns at most 200
 * runs, so a busy endpoint's failures from yesterday would otherwise fall out
 * of the window the console filters.
 * Returns last 50 logs by default, up to 200 with ?limit=200.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { prisma } from '@/lib/db'
import { deleteFunctionRuns, withRunBodies } from '@/lib/services/ai-functions/run-records'

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  return withProjectValidation<any>(request, async (validated) => {
    const { projectId } = validated
    const { searchParams } = request.nextUrl
    const functionId = searchParams.get('functionId') || undefined
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200)
    // Anything but 'true' or 'false' leaves the outcome unfiltered.
    const outcome = searchParams.get('success')
    const success = outcome === 'false' ? false : outcome === 'true' ? true : undefined

    // A regional project's run logs and errors are read from its region.
    const logs = await withRunBodies(projectId, await prisma.aiFunctionLog.findMany({
      where: {
        projectId,
        ...(functionId ? { functionId } : {}),
        ...(success !== undefined ? { success } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        function: {
          select: { name: true, triggerType: true },
        },
      },
    }))

    return NextResponse.json({ success: true, data: logs, count: logs.length })
  })
}

/**
 * DELETE /api/projects/:id/ai-functions/logs
 * Clear all logs for a project (or a specific function with ?functionId=xxx).
 *
 * Needs ADMIN, as deleting a function does (../[functionId]): cleared runs do
 * not come back.
 */
export async function DELETE(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  return withProjectValidation<any>(request, async (validated) => {
    const { projectId } = validated
    const { searchParams } = request.nextUrl
    const functionId = searchParams.get('functionId') || undefined

    // The platform rows and, for a regional project, what its region keeps of them.
    await deleteFunctionRuns(projectId, functionId)

    return NextResponse.json({ success: true, message: 'Logs cleared' })
  }, { floor: 'administer' })
}

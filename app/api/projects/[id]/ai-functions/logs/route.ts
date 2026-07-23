/**
 * GET /api/projects/:id/ai-functions/logs
 * Returns execution logs for all AI functions in a project.
 * Supports ?functionId=xxx to filter to a single function.
 * Returns last 50 logs by default, up to 200 with ?limit=200.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { prisma } from '@/lib/db'

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  return withProjectValidation<any>(request, async (validated) => {
    const { projectId } = validated
    const { searchParams } = request.nextUrl
    const functionId = searchParams.get('functionId') || undefined
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200)

    const logs = await prisma.aiFunctionLog.findMany({
      where: {
        projectId,
        ...(functionId ? { functionId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        function: {
          select: { name: true, triggerType: true },
        },
      },
    })

    return NextResponse.json({ success: true, data: logs, count: logs.length })
  })
}

/**
 * DELETE /api/projects/:id/ai-functions/logs
 * Clear all logs for a project (or a specific function with ?functionId=xxx).
 */
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  return withProjectValidation<any>(request, async (validated) => {
    const { projectId } = validated
    const { searchParams } = request.nextUrl
    const functionId = searchParams.get('functionId') || undefined

    await prisma.aiFunctionLog.deleteMany({
      where: {
        projectId,
        ...(functionId ? { functionId } : {}),
      },
    })

    return NextResponse.json({ success: true, message: 'Logs cleared' })
  })
}

/**
 * GET  /api/projects/:id/backup  — list backups
 * POST /api/projects/:id/backup  — trigger on-demand backup
 * PUT  /api/projects/:id/backup  — restore from a backup (requires backupId in body)
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { backupWorkspace, listBackups, restoreWorkspace } from '@/lib/services/workspace-backup'

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  return withProjectValidation<any>(request, async (validated) => {
    const { projectId } = validated
    const backups = await listBackups(projectId)
    return NextResponse.json({ success: true, data: backups })
  })
}

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  return withProjectValidation<any>(request, async (validated) => {
    const { projectId } = validated
    const result = await backupWorkspace(projectId)
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 })
    }
    return NextResponse.json({ success: true, data: result }, { status: 201 })
  })
}

export async function PUT(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  return withProjectValidation<any>(request, async (validated) => {
    const { projectId } = validated
    const body = await request.json().catch(() => ({}))
    const { backupId } = body

    const result = await restoreWorkspace(projectId, backupId)
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }
    return NextResponse.json({ success: true, data: result })
  })
}

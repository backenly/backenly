/**
 * PROJECT DATABASE SNAPSHOTS
 *
 *   GET  /api/projects/:id/backup  — list this project's snapshots
 *   POST /api/projects/:id/backup  — take one now
 *   PUT  /api/projects/:id/backup  — restore one (requires backupId in the body)
 *
 * Un-gated from Cloud once lib/recovery/ made the pair coherent. A snapshot
 * covers ONE project's schema and rows; it is not disaster recovery and the two
 * are named apart so an operator cannot mistake one for the other. See the
 * header of lib/services/workspace-backup.ts for what a snapshot excludes.
 *
 * The path stays `/backup` because it is an implementation route with tests and
 * a baseline entry against it. What the operator reads is the surface, and that
 * says "Database snapshot" everywhere.
 *
 * A project kept in another region has its snapshots taken and restored there
 * (requestBackup, requestRestore): this route answers 202 with the queued job,
 * and the list carries the project's recent regional jobs so the console can
 * show what is waiting, running or failed.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { listBackups, requestBackup, requestRestore, snapshotForJson } from '@/lib/services/workspace-backup'
import { regionalJobsOf } from '@/lib/queue'
import { getProjectServingState } from '@/lib/projects/serving-state'
import { regionErrorResponse } from '@/lib/api/v1/errors'

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  return withProjectValidation<any>(request, async (validated) => {
    const { projectId } = validated
    const [backups, jobs] = await Promise.all([listBackups(projectId), regionalJobsOf(projectId)])
    return NextResponse.json({ success: true, data: backups.map(snapshotForJson), jobs })
  })
}

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  return withProjectValidation<any>(request, async (validated) => {
    const { projectId } = validated
    // A region this process cannot reach is thrown as itself, never recorded as
    // a failed snapshot: 503, as for every other route that cannot reach it.
    let outcome: Awaited<ReturnType<typeof requestBackup>>
    try {
      outcome = await requestBackup(projectId, validated.userId)
    } catch (err) {
      const regional = regionErrorResponse(err)
      if (regional) return regional
      throw err
    }
    if (outcome.kind === 'queued') {
      return NextResponse.json({ success: true, queued: true, jobId: outcome.jobId, region: outcome.region }, { status: 202 })
    }
    if (!outcome.result.success) {
      return NextResponse.json({ error: outcome.result.error }, { status: 500 })
    }
    return NextResponse.json({ success: true, data: snapshotForJson(outcome.result) }, { status: 201 })
  })
}

export async function PUT(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  return withProjectValidation<any>(request, async (validated) => {
    const { projectId } = validated
    const body = await request.json().catch(() => ({}))
    const { backupId } = body

    // A restore rewrites the project's data, and nothing writes to a paused
    // project. Listing and taking snapshots stay open: those are how an owner
    // gets their data out. A queued restore checks again where it runs.
    const serving = await getProjectServingState(projectId)
    if (serving.kind === 'paused') {
      return NextResponse.json(
        { error: 'This project is paused. Resume it before restoring a snapshot.', code: 'PROJECT_PAUSED' },
        { status: 409 },
      )
    }

    let outcome: Awaited<ReturnType<typeof requestRestore>>
    try {
      outcome = await requestRestore(projectId, backupId, validated.userId)
    } catch (err) {
      const regional = regionErrorResponse(err)
      if (regional) return regional
      throw err
    }
    if (outcome.kind === 'queued') {
      return NextResponse.json({ success: true, queued: true, jobId: outcome.jobId, region: outcome.region }, { status: 202 })
    }
    if (!outcome.result.success) {
      return NextResponse.json({ error: outcome.result.error }, { status: 400 })
    }
    return NextResponse.json({ success: true, data: outcome.result })
  })
}

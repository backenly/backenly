export const dynamic = 'force-dynamic'

/**
 * Schema history for one project.
 *
 *   GET  /api/projects/[id]/schema-versions              list, newest first
 *   GET  /api/projects/[id]/schema-versions?versionId=…  one snapshot
 *   POST /api/projects/[id]/schema-versions              { versionId } → roll back
 *
 * ── Authorization, and why this file changed ────────────────────────────────
 *
 * This route used to call `verifyToken` and stop there. That proves the caller
 * is SOME signed-in user; it says nothing about whether the project in the URL
 * is theirs. The project id was then taken straight from the path and used
 * unchecked, so any authenticated account could read another tenant's full
 * schema snapshots — and, through POST, ROLL BACK ANOTHER TENANT'S SCHEMA.
 *
 * A classic IDOR, and the destructive half of it was reachable with one
 * request. It had no UI, which is why nothing noticed.
 *
 * `canAccessProject` / `canAdministerProject` are the repository's one
 * authority on this question, as every other `[id]` route uses them. Ownership
 * is checked BEFORE any argument reaches the versioning layer, because
 * `listSchemaVersions` and `rollbackToVersion` filter by the project id they
 * are handed and cannot tell a legitimate one from a guessed one.
 *
 * The read answers 404 rather than 403 for a project the caller cannot see, so
 * the endpoint is not an oracle for which project ids exist.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { canAccessProject, canAdministerProject } from '@/lib/edition/guard'
import { listSchemaVersions, getSchemaVersion, rollbackToVersion } from '@/lib/versioning/schema-versions'

export const GET = withAuth(async (request: NextRequest, { user, params }) => {
  try {
    const { id: projectId } = await params

    if (!(await canAccessProject(user.userId, projectId))) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const { searchParams } = new URL(request.url)
    const versionId = searchParams.get('versionId')

    if (versionId) {
      // Scoped to this project by the query itself. A version id lives in a
      // different namespace than a project id, so holding one proves nothing
      // about which project it belongs to.
      const version = await getSchemaVersion(versionId, projectId)
      if (!version) return NextResponse.json({ error: 'Version not found' }, { status: 404 })
      return NextResponse.json({ success: true, version })
    }

    const versions = await listSchemaVersions(projectId)
    return NextResponse.json({ success: true, versions, total: versions.length })
  } catch {
    return NextResponse.json({ error: 'Failed to list schema versions' }, { status: 500 })
  }
})

export const POST = withAuth(async (request: NextRequest, { user, params }) => {
  try {
    const { id: projectId } = await params

    // Administer, not merely access. A rollback rewrites the live schema, so it
    // is not something a read-only collaborator should be able to trigger.
    if (!(await canAdministerProject(user.userId, projectId))) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const body = await request.json().catch(() => ({}))
    const { versionId } = body ?? {}
    if (!versionId) {
      return NextResponse.json({ error: 'versionId is required' }, { status: 400 })
    }

    // Refused early with a clear answer. rollbackToVersion scopes the same
    // way, so this is a better error rather than the enforcement.
    if (!(await getSchemaVersion(versionId, projectId))) {
      return NextResponse.json({ error: 'Version not found' }, { status: 404 })
    }

    const result = await rollbackToVersion(projectId, versionId)
    return NextResponse.json({
      success: result.success,
      message: result.message,
      statementsExecuted: result.statementsExecuted,
    }, { status: result.success ? 200 : 500 })
  } catch (error: any) {
    return NextResponse.json({ error: 'Rollback failed', details: error.message }, { status: 500 })
  }
})

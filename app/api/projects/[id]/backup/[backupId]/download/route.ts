/**
 * GET /api/projects/:id/backup/:backupId/download — hand a database snapshot to
 * its project's administrator.
 *
 * The file is the scheduled or on-demand snapshot the platform already took
 * (lib/services/workspace-backup.ts): a pg_dump of the project's schema made
 * with the backup role, so it is complete even for FORCE RLS tables. It is
 * how an owner takes their data out of a paused project, including after
 * resuming it requires a paid plan, so it stays open while paused.
 *
 * ADMIN, not VIEWER, even though this is a GET: the dump contains every row,
 * end users' password hashes included. And it is a database snapshot, named as
 * one, never "a backup": it holds no storage files, keys or configuration (see
 * the header of workspace-backup.ts), and storage has its own export route.
 */

export const dynamic = 'force-dynamic'

import { createReadStream } from 'fs'
import { Readable } from 'stream'
import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth/middleware'
import { canAdministerProject } from '@/lib/edition/guard'
import { resolveSnapshotFile } from '@/lib/services/workspace-backup'

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ id: string; backupId: string }> },
) {
  const { id: projectId, backupId } = await props.params

  const auth = await authenticateRequest(request)
  if (!auth.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // 404 rather than 403, as every route in this family answers: a stranger
  // learns nothing about whether the project exists.
  if (!(await canAdministerProject(auth.userId, projectId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  const snapshot = await resolveSnapshotFile(projectId, backupId)
  if (!snapshot) {
    return NextResponse.json({ error: 'Snapshot not found' }, { status: 404 })
  }

  // Streamed, never buffered: a snapshot can be larger than the memory a web
  // task can spare for one request.
  const body = Readable.toWeb(createReadStream(snapshot.filePath)) as unknown as ReadableStream<Uint8Array>
  const safeName = snapshot.filename.replace(/[^a-zA-Z0-9._-]/g, '_')
  return new NextResponse(body, {
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Length': String(snapshot.sizeBytes),
      'Content-Disposition': `attachment; filename="database-snapshot-${safeName}"`,
      'Cache-Control': 'no-store',
    },
  })
}

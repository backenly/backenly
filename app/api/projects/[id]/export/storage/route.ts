/**
 * GET /api/projects/:id/export/storage — every stored file, as download links.
 *
 * The storage half of taking a project's data out; the database half is the
 * snapshot download. It must work while the project is paused, including after
 * resuming it requires a paid plan, so the links are EXPORT links
 * (lib/storage/export-token.ts): presigned straight to the bucket on S3, or an
 * export-scoped token on the local driver. Both still work while the download
 * route refuses ordinary traffic for a paused project.
 *
 * A manifest rather than one archive: no server-side zip of a project's whole
 * storage, no size ceiling, and a script can fetch the files in parallel and
 * resume. Links last an hour; request the manifest again for fresh ones.
 *
 *   ?offset=0&limit=500   (limit is capped at 1000)
 *
 * ADMIN only, like the snapshot download: the links read private files and
 * `owner_only` buckets on the administrator's authority.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth/middleware'
import { canAdministerProject } from '@/lib/edition/guard'
import { storageService } from '@/lib/services/storage'

const LINK_TTL_SECONDS = 3600
const MAX_PAGE = 1000

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await props.params

  const auth = await authenticateRequest(request)
  if (!auth.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await canAdministerProject(auth.userId, projectId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  const url = new URL(request.url)
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10) || 0)
  const limit = Math.min(MAX_PAGE, Math.max(1, parseInt(url.searchParams.get('limit') ?? '500', 10) || 500))

  // One extra row tells us whether another page exists without a count query.
  const page = await storageService.listFiles(undefined, projectId, { offset, limit: limit + 1 })
  const hasMore = page.length > limit
  const files = page.slice(0, limit)

  const expiresAt = new Date(Date.now() + LINK_TTL_SECONDS * 1000).toISOString()
  const entries = await Promise.all(
    files.map(async f => ({
      id: f.id,
      bucket: f.bucket,
      name: f.name,
      size: f.size.toString(), // BigInt does not serialise
      mimeType: f.mimeType,
      url: await storageService.getExportUrl(f.id, projectId, LINK_TTL_SECONDS),
    })),
  )

  return NextResponse.json(
    {
      projectId,
      files: entries,
      nextOffset: hasMore ? offset + limit : null,
      expiresAt,
      note: 'Links expire in one hour. Request this manifest again for fresh ones.',
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

/**
 * GET /api/projects/[id]/history?cursor=<iso>&limit=<n>
 *
 * The full, all-time "what changed in your app" feed that powers the History
 * page. Same data and the same plain-English labels as the dashboard's
 * "Recent Activity" card (lib/activity/feed.ts) — just un-capped, with no
 * 30-day window, and paginated.
 *
 * Pagination is cursor-based: each response carries `nextCursor`, which the
 * client passes back as `?cursor=` to load the next (older) page. `nextCursor`
 * is null when there is nothing older left.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { buildActivityFeed } from '@/lib/activity/feed'

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const params = await props.params
  return withProjectValidation<any>(request, async (validated) => {
    const url = new URL(request.url)
    const cursor = url.searchParams.get('cursor')

    const rawLimit = Number(url.searchParams.get('limit'))
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, 50)
      : 25

    const feed = await buildActivityFeed(validated.projectId, {
      limit,
      before: cursor || null,
      // No sinceDays — History is all-time, unlike the dashboard card.
    })

    return NextResponse.json({
      success: true,
      rows: feed.rows,
      nextCursor: feed.nextCursor,
    })
  })
}

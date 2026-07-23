/**
 * GET /api/projects/[id]/dashboard-stats
 *
 * Single endpoint behind the workspace home's four resource cards:
 *
 *   • tables  — row counts from workspace_{projectId}.{table} (top 12 by size)
 *   • buckets — per-bucket size + file count from storage_files
 *   • summary — end-user count + total workspace bytes
 *
 * Two payload members were dropped on 2026-07-21 with the panels that read
 * them, and neither should come back speculatively:
 *
 *   – `endpoints`: one ApiUsageLog query PER ApiDefinition row on every
 *     dashboard paint, to feed a panel that has since been deleted. Under
 *     PostgREST the API is the schema, and ApiDefinition no longer has writers.
 *   – `activity`: the Agent journal's feed, built from lib/activity/feed.ts's
 *     buildActivityFeed(). That helper's other caller (the un-capped History
 *     page) is untouched — only this route's use of it was removed.
 *
 * Realtime live metrics (active channels, connection count) are deliberately
 * absent — the runtime doesn't surface those today, and showing fabricated
 * numbers on a dashboard a non-dev trusts is the wrong default.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { prisma } from '@/lib/db/prisma'
import { listTableStats } from '@/lib/services/workspace-table-stats'
import { introspectAuthUsersTable, SYNTHETIC_USER_SQL } from '@/lib/services/end-user-auth-table'
import { executeWithUserContext } from '@/lib/services/workspace-rls'

interface TableStat    { name: string; rowCount: number; estimated: boolean }
interface BucketStat   { name: string; totalBytes: number; fileCount: number; isPublic: boolean }

/**
 * Headline counters for the resource cards. Both are nullable on purpose — a
 * project with no `users` table has no end-user count, and the cards render
 * '—' rather than a zero that would read as "nobody signed up yet".
 */
interface Summary {
  endUsers: number | null
  /** pg_total_relation_size summed over every table in workspace_{projectId}. */
  dbBytes: number | null
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  return withProjectValidation<any>(request, async (validated) => {
    const { projectId } = validated

    const [tableStats, buckets, endUsers] = await Promise.all([
      // null (not []) when the kernel throws, so `dbBytes` can stay unknown
      // instead of collapsing to a confident "0 B".
      listTableStats(projectId).catch(() => null),
      collectBucketStats(projectId).catch(() => [] as BucketStat[]),
      countEndUsers(projectId).catch(() => null),
    ])

    // Cap at 12 to keep the dashboard card lean; the kernel already sorts
    // heaviest-first. The size total is summed over ALL tables, not the slice —
    // a project with 30 tables must not report only the top 12's bytes.
    const tables: TableStat[] = (tableStats ?? []).slice(0, 12).map((s) => ({
      name: s.name,
      rowCount: s.rows,
      estimated: s.estimated,
    }))
    const summary: Summary = {
      endUsers,
      dbBytes: tableStats
        ? tableStats.reduce((acc, s) => acc + (s.bytes ?? 0), 0)
        : null,
    }

    return NextResponse.json({
      success: true,
      data: { tables, buckets, summary },
    })
  })
}

// ── end-users ─────────────────────────────────────────────────────────────
// The same population the Auth page's "identities" metric counts: every row in
// workspace_{projectId}.users that is neither soft-deleted nor a synthetic
// behavioral-verifier account. Returns null — never 0 — when the project has
// no users table at all, so the card can say "—" instead of claiming an empty
// signup list for a backend that has no auth yet.

async function countEndUsers(projectId: string): Promise<number | null> {
  const schema = await introspectAuthUsersTable(projectId)
  if (schema.columns.size === 0) return null

  const where = [`NOT ${SYNTHETIC_USER_SQL}`]
  if (schema.columns.has('deleted_at')) where.push(`"deleted_at" IS NULL`)

  // Service-role: the users table is RLS-FORCED with a service-role-only
  // policy. Ownership was already proven by withProjectValidation above.
  const rows = await executeWithUserContext<{ count: number }>(
    '',
    true,
    `SELECT COUNT(*)::int AS count FROM "${schema.schemaName}"."users" WHERE ${where.join(' AND ')}`,
    [],
  )
  return Number(rows[0]?.count ?? 0)
}

// ── storage buckets ──────────────────────────────────────────────────────

async function collectBucketStats(projectId: string): Promise<BucketStat[]> {
  const buckets = await prisma.storageBucket.findMany({
    where: { projectId },
    select: { id: true, name: true, isPublic: true },
  })

  if (buckets.length === 0) return []

  const stats = await Promise.all(
    buckets.map(async (b): Promise<BucketStat> => {
      const agg = await prisma.storageFile.aggregate({
        where: { bucketId: b.id, deletedAt: null },
        _sum: { size: true },
        _count: { _all: true },
      })
      return {
        name: b.name,
        // Project's tsconfig targets a lower ES version, so avoid `0n` —
        // Number() on a null-coalesced BigInt|null still yields a finite int
        // for sizes well under 2^53.
        totalBytes: Number(agg._sum.size ?? 0),
        fileCount: agg._count._all,
        isPublic: b.isPublic,
      }
    }),
  )

  return stats.sort((a, b) => b.totalBytes - a.totalBytes)
}

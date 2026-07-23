import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth/middleware'
import { listTablesWithRealtimeTriggers } from '@/lib/services/realtimeTriggers'

/**
 * GET /api/projects/:id/realtime-status
 *
 * Returns which tables have the backenly_realtime trigger installed,
 * plus presence stats (online user count from _backenly_presence).
 * Used by the Inspector → Realtime page AND the dashboard home card —
 * both surfaces MUST see the same value, so auth is delegated to the
 * canonical authenticateRequest (Bearer-then-cookie fallback) rather
 * than rolled inline (which previously rejected callers whose Bearer
 * token had gone stale even when their session cookie was still valid).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await authenticateRequest(request)
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json(
        { error: auth.error ?? 'Authentication required' },
        { status: 401 }
      )
    }

    const projectId = params.id

    const project = await prisma.project.findFirst({
      where: { id: projectId, userId: auth.userId },
      select: { id: true },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Tables that have the trigger installed (exclude phantom _apis tables from BUG-01)
    // `users` is filtered here as well as at install time. Installation is now
    // refused for auth-managed tables, but triggers created before that fix
    // still exist in older schemas, and the dashboard must not advertise them
    // as a streaming surface while the cleanup runs.
    const { isAuthManagedTable } = await import('@/lib/mcp/schema-introspection')
    let triggeredTables = (await listTablesWithRealtimeTriggers(projectId))
      .filter((n: string) => !n.endsWith('_apis') && !isAuthManagedTable(n))

    // ── A GET does not enable a feature ───────────────────────────────────────
    //
    // This used to retro-install NOTIFY triggers on EVERY workspace table
    // whenever it found none — meaning opening the Realtime page turned realtime
    // on, project-wide, for a project that had never asked for it. Combined with
    // CREATE_TABLE's old unconditional install, that is how a project ended up
    // with per-row triggers on every table with no record of anyone requesting
    // them, and why a scoped `enable_realtime { table: "orders" }` appeared to
    // have covered `products` and `order_items` as well.
    //
    // Realtime is opt-in. When nothing is streaming, say so and let the caller
    // decide — `enable_realtime` (agent) or the page's own action (human) is the
    // door. Reading state must never be the thing that changes it.
    const enabled = triggeredTables.length > 0

    // Online user count (presence) — best-effort, table may not exist yet
    let onlineUsers = 0
    try {
      const { queryWorkspaceSchema } = await import('@/lib/services/workspaceDatabase')
      const rows = await queryWorkspaceSchema(
        projectId,
        `SELECT COUNT(*) AS cnt
         FROM "_backenly_presence"
         WHERE "lastSeen" > NOW() - INTERVAL '90 seconds'`
      ) as Array<{ cnt: string }>
      onlineUsers = parseInt(rows?.[0]?.cnt ?? '0', 10)
    } catch {
      // Presence table hasn't been bootstrapped yet — ignore
    }

    return NextResponse.json({
      enabled,
      triggeredTables,
      onlineUsers,
      channel: `workspace_${projectId}_changes`,
    })
  } catch (err: any) {
    console.error('[realtime-status]', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

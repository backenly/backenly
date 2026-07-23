export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withTenantIsolation, TenantIsolationError } from '@/lib/tenant/isolation'
import { introspectAuthUsersTable, SYNTHETIC_USER_SQL } from '@/lib/services/end-user-auth-table'
import { executeWithUserContext } from '@/lib/services/workspace-rls'

const ZERO = {
  totalUsers: 0,
  activeUsers: 0,
  activeUsersDelta: 0,
  verifications: 0,
  signups24h: 0,
  signupsDelta: 0,
  signups7d: 0,
}

/**
 * GET /api/auth/users/stats — identity metrics for a project's END-USERS.
 *
 * Reads the project's `workspace_{projectId}.users` table (raw SQL, RLS-forced
 * with a service-role-only policy — hence every count runs under service-role).
 * Ownership is verified by `withTenantIsolation` first.
 *
 * Every metric is computed only from columns that actually exist on the live
 * table, so an AI-generated users table missing `last_login` / `oauth_provider`
 * degrades to 0 for that metric instead of 500-ing the Auth page.
 *   - identities   → all non-soft-deleted rows
 *   - active · 30d → rows with last_login in the trailing 30 days
 *   - verified     → OAuth-authenticated rows (provider-verified emails)
 *   - new · 24h    → rows created in the trailing 24 hours
 */
export async function GET(request: NextRequest) {
  try {
    return await withTenantIsolation(request, async (projectId) => {
      const schema = await introspectAuthUsersTable(projectId)
      const schemaName = schema.schemaName

      if (schema.columns.size === 0) return NextResponse.json(ZERO)

      const has = (c: string) => schema.columns.has(c)
      const createdAtCol = schema.createdAtColumn
      const lastLoginCol = schema.lastLoginColumn
      const verifiedExpr = has('email_verified')
        ? `"email_verified" = TRUE`
        : has('verified')
          ? `"verified" = TRUE`
          : has('oauth_provider')
            ? `"oauth_provider" IS NOT NULL`
            : null

      const created = createdAtCol ? `"${createdAtCol}"` : null
      const lastLogin = lastLoginCol ? `"${lastLoginCol}"` : null

      // One round-trip: conditional aggregates over the (non-deleted) table.
      const select: string[] = ['COUNT(*)::int AS "totalUsers"']
      if (lastLogin) {
        select.push(`COUNT(*) FILTER (WHERE ${lastLogin} >= NOW() - INTERVAL '30 days')::int AS "activeUsers"`)
        select.push(`COUNT(*) FILTER (WHERE ${lastLogin} >= NOW() - INTERVAL '60 days' AND ${lastLogin} < NOW() - INTERVAL '30 days')::int AS "prevActiveUsers"`)
      }
      if (verifiedExpr) {
        select.push(`COUNT(*) FILTER (WHERE ${verifiedExpr})::int AS "verifications"`)
      }
      if (created) {
        select.push(`COUNT(*) FILTER (WHERE ${created} >= NOW() - INTERVAL '24 hours')::int AS "signups24h"`)
        select.push(`COUNT(*) FILTER (WHERE ${created} >= NOW() - INTERVAL '48 hours' AND ${created} < NOW() - INTERVAL '24 hours')::int AS "prevSignups"`)
        select.push(`COUNT(*) FILTER (WHERE ${created} >= NOW() - INTERVAL '7 days')::int AS "signups7d"`)
      }

      // Exclude soft-deleted rows and internal behavioral-verifier accounts so
      // the identity metrics reflect only real end-users.
      const whereParts = [`NOT ${SYNTHETIC_USER_SQL}`]
      if (has('deleted_at')) whereParts.push(`"deleted_at" IS NULL`)
      const whereClause = `WHERE ${whereParts.join(' AND ')}`
      const sql = `SELECT ${select.join(', ')} FROM "${schemaName}"."users" ${whereClause}`

      const rows = await executeWithUserContext<any>('', true, sql, [])
      const r = rows[0] ?? {}

      const activeUsers = Number(r.activeUsers ?? 0)
      const prevActive = Number(r.prevActiveUsers ?? 0)
      const activeUsersDelta =
        prevActive > 0
          ? Math.round(((activeUsers - prevActive) / prevActive) * 100)
          : activeUsers > 0
            ? 100
            : 0

      const signups24h = Number(r.signups24h ?? 0)
      const prevSignups = Number(r.prevSignups ?? 0)
      const signupsDelta =
        prevSignups > 0
          ? Math.round(((signups24h - prevSignups) / prevSignups) * 100)
          : signups24h > 0
            ? 100
            : 0

      return NextResponse.json({
        totalUsers: Number(r.totalUsers ?? 0),
        activeUsers,
        activeUsersDelta,
        verifications: Number(r.verifications ?? 0),
        signups24h,
        signupsDelta,
        signups7d: Number(r.signups7d ?? 0),
      })
    })
  } catch (error: any) {
    if (error instanceof TenantIsolationError) {
      return NextResponse.json({ error: error.message }, { status: 403 })
    }
    console.error('[Auth Stats] Error:', error)
    // Non-fatal: the Auth page treats stats as best-effort. Return zeros so the
    // page renders instead of showing an error state.
    return NextResponse.json(ZERO)
  }
}

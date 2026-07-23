export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withTenantIsolation, TenantIsolationError } from '@/lib/tenant/isolation'
import { introspectAuthUsersTable, SYNTHETIC_USER_SQL } from '@/lib/services/end-user-auth-table'
import { executeWithUserContext } from '@/lib/services/workspace-rls'

/**
 * GET /api/auth/users — list the END-USERS of a project.
 *
 * These users live in the project's own workspace schema
 * (`workspace_{projectId}.users`), which is a raw-SQL table, NOT a Prisma
 * model. They are completely separate from the Backenly platform `User` table.
 *
 * Two hard requirements this route must satisfy:
 *   1. The users table has RLS enabled + FORCED with a service-role-only policy,
 *      so a plain query returns ZERO rows. Every read here runs under
 *      service-role context (project ownership is already verified by
 *      `withTenantIsolation`, so the owner is authorised to see all end-users).
 *   2. The table's column set is not fixed — an AI-generated table may lack
 *      `role`, `name`, `last_login`, etc. We introspect the live schema and
 *      reference only columns that exist, so schema drift can never 500 the page.
 */
export async function GET(request: NextRequest) {
  try {
    return await withTenantIsolation(request, async (projectId) => {
      const schema = await introspectAuthUsersTable(projectId)
      const schemaName = schema.schemaName

      // No users table yet → empty result, not an error.
      if (schema.columns.size === 0) {
        return NextResponse.json({
          users: [],
          pagination: { page: 1, limit: 50, total: 0, totalPages: 0 },
        })
      }

      const searchParams = request.nextUrl.searchParams
      const search = (searchParams.get('search') || '').trim()
      const page = Math.max(1, parseInt(searchParams.get('page') || '1') || 1)
      const limit = Math.min(200, Math.max(1, parseInt(searchParams.get('limit') || '50') || 50))
      const offset = (page - 1) * limit

      const has = (c: string) => schema.columns.has(c)
      const createdAtCol = schema.createdAtColumn
      const lastLoginCol = schema.lastLoginColumn
      const providerCol = has('oauth_provider') ? 'oauth_provider' : null

      // Only reference columns that exist on the live table.
      const selectCols: string[] = ['id', 'email']
      if (schema.hasName) selectCols.push('name')
      if (schema.hasRole) selectCols.push('role')
      if (providerCol) selectCols.push(`"${providerCol}"`)
      if (createdAtCol) selectCols.push(`"${createdAtCol}"`)
      if (lastLoginCol) selectCols.push(`"${lastLoginCol}"`)
      if (schema.hasIsBlocked) selectCols.push('is_blocked')

      // WHERE: exclude soft-deleted rows; optional case-insensitive search.
      const whereParts: string[] = []
      const values: unknown[] = []
      if (has('deleted_at')) whereParts.push(`"deleted_at" IS NULL`)
      // Never show internal behavioral-verifier accounts to the developer.
      whereParts.push(`NOT ${SYNTHETIC_USER_SQL}`)
      if (search) {
        values.push(`%${search}%`)
        const idx = values.length
        const searchCols = [`email ILIKE $${idx}`]
        if (schema.hasName) searchCols.push(`name ILIKE $${idx}`)
        whereParts.push(`(${searchCols.join(' OR ')})`)
      }
      const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : ''
      const orderCol = createdAtCol ? `"${createdAtCol}"` : 'id'

      // Data page + total count, both under service-role (RLS is service-role only).
      const listSql =
        `SELECT ${selectCols.join(', ')} FROM "${schemaName}"."users" ` +
        `${whereClause} ORDER BY ${orderCol} DESC ` +
        `LIMIT ${limit} OFFSET ${offset}`
      const countSql = `SELECT COUNT(*)::int AS count FROM "${schemaName}"."users" ${whereClause}`

      const [rows, countRows] = await Promise.all([
        executeWithUserContext<any>('', true, listSql, values),
        executeWithUserContext<{ count: number }>('', true, countSql, values),
      ])

      const total = countRows[0]?.count ?? 0

      const users = rows.map((u: any) => ({
        id: u.id,
        email: u.email,
        name: u.name ?? null,
        provider: (providerCol && u[providerCol]) ? String(u[providerCol]) : 'email',
        verified: !!(providerCol && u[providerCol]), // provider-verified emails
        lastLogin: lastLoginCol ? (u[lastLoginCol] ?? null) : null,
        createdAt: createdAtCol ? u[createdAtCol] : null,
        isBlocked: schema.hasIsBlocked ? !!u.is_blocked : false,
      }))

      return NextResponse.json({
        users,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      })
    })
  } catch (error: any) {
    if (error instanceof TenantIsolationError) {
      return NextResponse.json({ error: error.message }, { status: 403 })
    }
    console.error('[Auth Users] Error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to fetch auth users' },
      { status: 500 }
    )
  }
}

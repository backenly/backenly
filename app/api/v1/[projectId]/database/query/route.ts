export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { v1ApiMiddleware, requirePermission, requireCapability } from '@/lib/api/v1/middleware'
import { createErrorResponse, createSuccessResponse, handleValidationError, ErrorCodes } from '@/lib/api/v1/errors'
import { querySchema, PAGINATION_DEFAULT_LIMIT, PAGINATION_MAX_LIMIT } from '@/lib/api/v1/schemas'
import { validateRequestBody } from '@/lib/validation/schemas'
import { prisma } from '@/lib/db'
import { executeWithUserContext } from '@/lib/services/workspace-rls'

/**
 * GET /v1/{projectId}/database/query?table=<name>&limit=&offset=&sort=&order=
 * Query database tables in the project's workspace schema (browser-friendly)
 */
export async function GET(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  try {
    const middleware = await v1ApiMiddleware(request, params)
    if (middleware.response) return middleware.response
    const { context } = middleware

    const permissionCheck = requirePermission(context, ['read', 'admin'])
    if (permissionCheck) return permissionCheck

    const { searchParams } = request.nextUrl
    const table = searchParams.get('table')
    if (!table) {
      return createErrorResponse(ErrorCodes.BAD_REQUEST, 'Missing required query param: table', 400)
    }
    const tableName = table.toLowerCase()

    // Strict identifier validation — reject anything that isn't a plain SQL identifier
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(tableName)) {
      return createErrorResponse(ErrorCodes.BAD_REQUEST, 'Invalid table name', 400)
    }

    const schemaName = `workspace_${context.projectId}`

    const tableRecord = await prisma.table.findFirst({
      where: { projectId: context.projectId, name: tableName },
    })
    if (!tableRecord) {
      return createErrorResponse(ErrorCodes.NOT_FOUND, `Table '${table}' not found in this project`, 404)
    }

    // Parse limit safely — parseInt('abc') returns NaN which must be caught
    const rawLimit = parseInt(searchParams.get('limit') ?? '', 10)
    const limit = Math.min(
      Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : PAGINATION_DEFAULT_LIMIT,
      PAGINATION_MAX_LIMIT
    )
    // Support both ?offset= and ?page= (page is 0-indexed)
    const pageParam = searchParams.get('page')
    const offsetParam = searchParams.get('offset')
    const rawPage   = parseInt(pageParam   ?? '', 10)
    const rawOffset = parseInt(offsetParam ?? '', 10)
    const offset = pageParam !== null
      ? Math.max(0, Number.isFinite(rawPage) ? rawPage : 0) * limit
      : Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0)
    const sort   = searchParams.get('sort')  || 'id'
    const order  = (searchParams.get('order') || 'asc').toUpperCase() === 'DESC' ? 'DESC' : 'ASC'

    // Sanitize sort column
    let safeSort = /^[a-z_][a-z0-9_]*$/i.test(sort) ? sort : 'id'

    // Support simple GET filters: ?status=active, ?type=video, etc.
    // Any query param not in the reserved set is treated as a column=value filter.
    const RESERVED_PARAMS = new Set(['table', 'limit', 'offset', 'page', 'sort', 'order'])
    const filterParts: string[] = []
    const filterValues: any[] = []
    let filterParamIdx = 1
    for (const [key, val] of searchParams.entries()) {
      if (RESERVED_PARAMS.has(key)) continue
      if (!/^[a-z_][a-z0-9_]*$/i.test(key)) continue
      // null/NULL string → IS NULL
      if (val === 'null' || val === 'NULL') {
        filterParts.push(`"${key}" IS NULL`)
      } else {
        filterParts.push(`"${key}" = $${filterParamIdx++}`)
        filterValues.push(val)
      }
    }

    // Auto-exclude soft-deleted rows (tables with deleted_at column)
    const hasSoftDelete = await prisma.$queryRawUnsafe<{ count: number }[]>(
      `SELECT COUNT(*)::int AS count FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2 AND column_name = 'deleted_at'`,
      schemaName, tableName
    ).then(r => Number(r[0]?.count ?? 0) > 0).catch(() => false)

    const liveColumns = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2`,
      schemaName, tableName
    ).catch(() => [] as { column_name: string }[])
    const columnSet = new Set(liveColumns.map(c => c.column_name))
    if (!columnSet.has(safeSort)) safeSort = ''

    // Only exclude deleted rows if caller hasn't explicitly filtered on deleted_at
    const callerFilteredDeletedAt = filterParts.some(p => p.includes('"deleted_at"'))
    if (hasSoftDelete && !callerFilteredDeletedAt) {
      filterParts.push('deleted_at IS NULL')
    }

    // Cursor-based pagination: ?cursor=<lastId>&cursorColumn=id
    // When cursor is present, offset-based pagination is ignored and we use
    // WHERE cursorColumn > cursor (or < for DESC), which is O(log n) on indexed columns.
    const cursorValue  = searchParams.get('cursor')
    const cursorColumn = searchParams.get('cursorColumn')
    let safeCursorCol = (cursorColumn && /^[a-z_][a-z0-9_]*$/i.test(cursorColumn))
      ? cursorColumn
      : (safeSort || 'id')
    if (!columnSet.has(safeCursorCol)) safeCursorCol = ''

    if (cursorValue && safeCursorCol) {
      const cursorOp = order === 'DESC' ? '<' : '>'
      filterParts.push(`"${safeCursorCol}" ${cursorOp} $${filterParamIdx++}`)
      filterValues.push(cursorValue)
    }

    const whereClause = filterParts.length > 0 ? `WHERE ${filterParts.join(' AND ')}` : ''

    const countSql = `SELECT COUNT(*)::int AS count FROM "${schemaName}"."${tableName}" ${whereClause}`
    // When using cursor pagination, OFFSET is 0 (we already encoded position in WHERE)
    const effectiveOffset = cursorValue ? 0 : offset
    const orderByClause = safeSort ? `ORDER BY "${safeSort}" ${order}` : ''
    const dataSql  = `SELECT * FROM "${schemaName}"."${tableName}" ${whereClause} ${orderByClause} LIMIT ${limit} OFFSET ${effectiveOffset}`

    const [countResult, rows] = await Promise.all([
      executeWithUserContext<{ count: number }>(context.endUserId ?? '', context.apiKey.serviceRole, countSql, filterValues, context.endUserRole ?? 'user'),
      executeWithUserContext<any>(context.endUserId ?? '', context.apiKey.serviceRole, dataSql, filterValues, context.endUserRole ?? 'user'),
    ])

    const total = countResult[0]?.count ?? 0
    const hasMore = cursorValue
      ? rows.length === limit  // cursor mode: more exists if full page returned
      : effectiveOffset + rows.length < total

    // Provide nextCursor for efficient cursor-based pagination on large tables
    const nextCursor = (hasMore && rows.length > 0)
      ? String((rows[rows.length - 1] as any)?.[safeCursorCol] ?? '')
      : null

    return createSuccessResponse(
      { data: rows, count: total },
      {
        limit,
        page: cursorValue ? undefined : Math.floor(effectiveOffset / limit),
        total,
        hasMore,
        nextCursor,
      }
    )
  } catch (error: any) {
    console.error('Database query GET error:', error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, 'Failed to execute database query', 500)
  }
}

/**
 * POST /v1/{projectId}/database/query
 * Query database tables with filters/select/orderBy (advanced)
 */
export async function POST(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  try {
    const middleware = await v1ApiMiddleware(request, params)
    if (middleware.response) {
      return middleware.response
    }

    const { context } = middleware

    const permissionCheck = requirePermission(context, ['read', 'admin'])
    if (permissionCheck) {
      return permissionCheck
    }

    const capabilityCheck = requireCapability(context, request.nextUrl.pathname)
    if (capabilityCheck) {
      return capabilityCheck
    }

    const validation = await validateRequestBody(querySchema, request)
    if (!validation.success) {
      return handleValidationError((validation as { success: false; error: string; status: number }).error as any)
    }

    const { table, select, where, orderBy, limit = 100, page } = validation.data
    const offset = page !== undefined ? page * (limit ?? 100) : (validation.data.offset ?? 0)
    const tableName = table.toLowerCase()

    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(tableName)) {
      return createErrorResponse(ErrorCodes.BAD_REQUEST, 'Invalid table name', 400)
    }

    const schemaName = `workspace_${context.projectId}`

    // Verify table belongs to this project
    const tableRecord = await prisma.table.findFirst({
      where: { projectId: context.projectId, name: tableName },
    })
    if (!tableRecord) {
      return createErrorResponse(ErrorCodes.NOT_FOUND, `Table '${table}' not found in this project`, 404)
    }

    // Build WHERE clause from filter object
    const whereParts: string[] = []
    const whereValues: any[] = []
    let paramIdx = 1

    if (where && typeof where === 'object') {
      for (const [col, val] of Object.entries(where)) {
        // Sanitize column name (only allow alphanumeric + underscore)
        if (!/^[a-z_][a-z0-9_]*$/i.test(col)) continue
        if (val !== null && typeof val === 'object') {
          const op = val as any
          if (op.gt !== undefined)  { whereParts.push(`"${col}" > $${paramIdx++}`); whereValues.push(op.gt) }
          if (op.gte !== undefined) { whereParts.push(`"${col}" >= $${paramIdx++}`); whereValues.push(op.gte) }
          if (op.lt !== undefined)  { whereParts.push(`"${col}" < $${paramIdx++}`); whereValues.push(op.lt) }
          if (op.lte !== undefined) { whereParts.push(`"${col}" <= $${paramIdx++}`); whereValues.push(op.lte) }
          if (op.not !== undefined) { whereParts.push(`"${col}" != $${paramIdx++}`); whereValues.push(op.not) }
          if (op.contains !== undefined) { whereParts.push(`"${col}" ILIKE $${paramIdx++}`); whereValues.push(`%${op.contains}%`) }
          if (op.in !== undefined && Array.isArray(op.in)) {
            const placeholders = op.in.map(() => `$${paramIdx++}`).join(', ')
            whereParts.push(`"${col}" IN (${placeholders})`)
            whereValues.push(...op.in)
          }
        } else {
          whereParts.push(`"${col}" = $${paramIdx++}`)
          whereValues.push(val)
        }
      }
    }

    // Auto-exclude soft-deleted rows (tables with deleted_at column) unless caller explicitly filters on it
    const callerFilteredDeletedAt = whereParts.some(p => p.includes('"deleted_at"'))
    if (!callerFilteredDeletedAt) {
      const hasSoftDeletePost = await prisma.$queryRawUnsafe<{ count: number }[]>(
        `SELECT COUNT(*)::int AS count FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = 'deleted_at'`,
        `workspace_${context.projectId}`, tableName
      ).then(r => Number(r[0]?.count ?? 0) > 0).catch(() => false)
      if (hasSoftDeletePost) {
        whereParts.push('deleted_at IS NULL')
      }
    }

    const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : ''

    // Build ORDER BY
    let orderByClause = ''
    if (orderBy && typeof orderBy === 'object') {
      const parts = Object.entries(orderBy)
        .filter(([col]) => /^[a-z_][a-z0-9_]*$/i.test(col))
        .map(([col, dir]) => `"${col}" ${String(dir).toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`)
      if (parts.length > 0) orderByClause = `ORDER BY ${parts.join(', ')}`
    }

    // Build SELECT clause — validate each column name to prevent injection
    const selectClause = (select && select.length > 0)
      ? select.filter(c => /^[a-z_][a-z0-9_]*$/i.test(c)).map(c => `"${c}"`).join(', ') || '*'
      : '*'

    const countSql = `SELECT COUNT(*)::int AS count FROM "${schemaName}"."${tableName}" ${whereClause}`
    const dataSql  = `SELECT ${selectClause} FROM "${schemaName}"."${tableName}" ${whereClause} ${orderByClause} LIMIT ${Number(limit)} OFFSET ${Number(offset)}`

    const [countResult, rows] = await Promise.all([
      executeWithUserContext<{ count: number }>(context.endUserId ?? '', context.apiKey.serviceRole, countSql, whereValues, context.endUserRole ?? 'user'),
      executeWithUserContext<any>(context.endUserId ?? '', context.apiKey.serviceRole, dataSql, whereValues, context.endUserRole ?? 'user'),
    ])

    const total = countResult[0]?.count ?? 0

    return createSuccessResponse(
      { data: rows, count: total },
      { limit, page: Math.floor(offset / limit), total, hasMore: offset + rows.length < total }
    )
  } catch (error: any) {
    console.error('Database query error:', error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, 'Failed to execute database query', 500)
  }
}


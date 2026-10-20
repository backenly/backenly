import { Router, Request, Response } from 'express'
import { prisma } from '@/lib/db'
import { v1AuthMiddleware, checkPermission, checkCapability } from '../lib/auth'
import { sendError, sendSuccess, ErrorCodes } from '../lib/response'
import { z } from 'zod'
import { refusedDataRequest } from '@/lib/api/v1/data-errors'
import { typedParams, type TypedParams } from '@/lib/api/v1/typed-params'
import { whereConditions } from '@/lib/api/v1/where'
import type { QueryContext } from '@/lib/db/query-errors'
import { columnTypes } from '@/lib/mcp/runtime-db'
import { executeWithUserContext } from '@/lib/services/workspace-rls'
import { resolveEndUserFromToken } from '../lib/end-user-identity'
import { applyIncludes, UnknownRelationError } from '@/lib/services/relational-include'
import { workspaceTableExists } from '@/lib/mcp/schema-introspection'
import { asyncRoute } from '../lib/async-route'

const router = Router()

// ── RLS identity ───────────────────────────────────────────────────────────────

interface RlsIdentity {
  userId: string
  isServiceRole: boolean
  role: string
  /** The token belonged to a user the owner blocked — the request must 403. */
  blocked?: boolean
}

/**
 * Resolve the RLS identity for a request, mirroring the dynamic CRUD path:
 * service-role keys bypass RLS; non-service keys act as the end-user named by
 * X-User-Token (or as no one — own_rows then matches zero rows, the secure
 * default). Workspace tables are FORCE RLS, so raw queries without this
 * context silently return nothing for signed-in users.
 */
async function resolveRlsIdentity(req: Request, projectId: string, serviceRole: boolean): Promise<RlsIdentity> {
  if (serviceRole) return { userId: '', isServiceRole: true, role: 'user' }
  const endUser = await resolveEndUserFromToken(
    projectId,
    req.headers['x-user-token'] as string | undefined,
  )
  // A blocked user gets the promised 403, never a silent downgrade to the
  // anonymous identity — public-readable tables would still serve them.
  if (endUser === 'blocked') return { userId: '', isServiceRole: false, role: 'user', blocked: true }
  if (endUser) return { userId: endUser.userId, isServiceRole: false, role: endUser.role }
  return { userId: '', isServiceRole: false, role: 'user' }
}

/** Answer the promised 403 for a blocked end-user; true when the request is done. */
function refuseIfBlocked(res: Response, rls: RlsIdentity): boolean {
  if (!rls.blocked) return false
  sendError(res, ErrorCodes.FORBIDDEN, 'This account has been blocked by the project owner.', 403)
  return true
}

// ── Schemas ────────────────────────────────────────────────────────────────────

const querySchema = z.object({
  table: z.string(),
  where: z.record(z.any()).optional(),
  orderBy: z.record(z.enum(['asc', 'desc', 'ASC', 'DESC'])).optional(),
  limit: z.number().int().min(1).max(1000).default(100),
  offset: z.number().int().min(0).default(0),
  // Relational includes: { comments: true, author: { include: { … } } }
  include: z.record(z.any()).optional(),
})

const insertSchema = z.object({
  table: z.string(),
  data: z.union([z.record(z.any()), z.array(z.record(z.any()))]),
})

const updateSchema = z.object({
  table: z.string(),
  where: z.record(z.any()).optional(),
  data: z.record(z.any()),
})

const deleteSchema = z.object({
  table: z.string(),
  where: z.record(z.any()),
})

// ── WHERE clause and refusals ──────────────────────────────────────────────────

/**
 * The WHERE clause for `where`, built as the Next routes build it
 * (lib/api/v1/where.ts): the same operators, each value cast to its column's
 * type through `bound`. Bound uncast, a value for a uuid, timestamp, numeric
 * or boolean column was refused by PostgreSQL, so getting, updating or
 * deleting a row by its uuid id answered 500.
 */
function whereSql(where: Record<string, unknown> | undefined, bound: TypedParams, types: Map<string, string>): string {
  const conditions = whereConditions(where, bound, types)
  return conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
}

/**
 * Answer a request refused for what it asked, 400 or 409 naming the column
 * (lib/api/v1/data-errors.ts); true when the request is done.
 */
function sendRefusal(res: Response, error: unknown, context: QueryContext | undefined): boolean {
  const refused = refusedDataRequest(error, context)
  if (!refused) return false
  sendError(res, refused.code, refused.message, refused.status, refused.details)
  return true
}

// ── POST /api/v1/:projectId/database/query ─────────────────────────────────────

router.post('/:projectId/database/query', asyncRoute(v1AuthMiddleware), asyncRoute(async (req: Request, res: Response) => {
  const ctx = req.v1Context!

  if (!checkPermission(res, ctx, ['read', 'admin'])) return
  if (!checkCapability(res, ctx, '/database')) return

  const parsed = querySchema.safeParse(req.body)
  if (!parsed.success) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'Request validation failed', 400, {
      fields: parsed.error.flatten().fieldErrors,
    })
    return
  }

  const { table, where, orderBy, limit, offset, include } = parsed.data
  const tableName = table.toLowerCase()
  const schemaName = `workspace_${ctx.projectId}`
  // What was bound, so a refusal can name its column.
  let refusal: QueryContext | undefined

  try {
    // Catalog-truth existence gate (single source of truth). Servable iff the
    // table physically exists and is exposed — no prisma.table metadata record
    // required, so a freshly-created table works instantly and a dropped one
    // stops instantly. Was: prisma.table.findFirst (a metadata copy that drifts).
    if (!(await workspaceTableExists(ctx.projectId, tableName))) {
      sendError(res, ErrorCodes.NOT_FOUND, `Table '${table}' not found in this project`, 404)
      return
    }

    // A blocked end-user is answered 403 before anything in the request is read.
    const rls = await resolveRlsIdentity(req, ctx.projectId, ctx.apiKey.serviceRole)
    if (refuseIfBlocked(res, rls)) return

    const types = await columnTypes(ctx.projectId, schemaName, tableName)
    const bound = typedParams(types)
    refusal = bound.context(tableName)
    const whereClause = whereSql(where, bound, types)

    let orderByClause = ''
    if (orderBy && typeof orderBy === 'object') {
      const parts = Object.entries(orderBy)
        .filter(([col]) => /^[a-z_][a-z0-9_]*$/i.test(col))
        .map(([col, dir]) => `"${col}" ${String(dir).toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`)
      if (parts.length > 0) orderByClause = `ORDER BY ${parts.join(', ')}`
    }

    const countSql = `SELECT COUNT(*)::int AS count FROM "${schemaName}"."${tableName}" ${whereClause}`
    const dataSql  = `SELECT * FROM "${schemaName}"."${tableName}" ${whereClause} ${orderByClause} LIMIT ${Number(limit)} OFFSET ${Number(offset)}`

    const [countResult, rows] = await Promise.all([
      executeWithUserContext<{ count: number }>(ctx.projectId, rls.userId, rls.isServiceRole, countSql, bound.values, rls.role),
      executeWithUserContext<any>(ctx.projectId, rls.userId, rls.isServiceRole, dataSql, bound.values, rls.role),
    ])

    if (include) {
      await applyIncludes({ projectId: ctx.projectId, tableName, rows, include, rls })
    }

    const total = countResult[0]?.count ?? 0
    sendSuccess(res, { data: rows, count: total }, {
      limit, page: Math.floor(offset / limit), total, hasMore: offset + rows.length < total,
    })
  } catch (error: any) {
    if (error instanceof UnknownRelationError) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, error.message, 400, {
        relation: error.relation, table: error.table, available: error.available,
      })
      return
    }
    if (sendRefusal(res, error, refusal)) return
    console.error('Database query error:', error)
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to execute database query', 500)
  }
}))

// ── POST /api/v1/:projectId/database/insert ────────────────────────────────────

router.post('/:projectId/database/insert', asyncRoute(v1AuthMiddleware), asyncRoute(async (req: Request, res: Response) => {
  const ctx = req.v1Context!

  if (!checkPermission(res, ctx, ['write', 'admin'])) return
  if (!checkCapability(res, ctx, '/database')) return

  const parsed = insertSchema.safeParse(req.body)
  if (!parsed.success) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'Request validation failed', 400, {
      fields: parsed.error.flatten().fieldErrors,
    })
    return
  }

  const { table, data } = parsed.data
  const tableName = table.toLowerCase()
  const schemaName = `workspace_${ctx.projectId}`
  // What was bound, so a refusal can name its column.
  let refusal: QueryContext | undefined

  try {
    // Catalog-truth existence gate (single source of truth). Servable iff the
    // table physically exists and is exposed — no prisma.table metadata record
    // required, so a freshly-created table works instantly and a dropped one
    // stops instantly. Was: prisma.table.findFirst (a metadata copy that drifts).
    if (!(await workspaceTableExists(ctx.projectId, tableName))) {
      sendError(res, ErrorCodes.NOT_FOUND, `Table '${table}' not found in this project`, 404)
      return
    }

    const rows = Array.isArray(data) ? data : [data]
    const inserted: any[] = []

    const rls = await resolveRlsIdentity(req, ctx.projectId, ctx.apiKey.serviceRole)
    if (refuseIfBlocked(res, rls)) return
    // Each value is cast to its column's type (lib/api/v1/typed-params.ts).
    const types = await columnTypes(ctx.projectId, schemaName, tableName)
    for (const row of rows) {
      const cols = Object.keys(row).filter(c => /^[a-z_][a-z0-9_]*$/i.test(c))
      if (cols.length === 0) continue
      const colList = cols.map(c => `"${c}"`).join(', ')
      const bound = typedParams(types)
      refusal = bound.context(tableName)
      const placeholders = cols.map(c => bound.bind(c, row[c])).join(', ')
      const sql = `INSERT INTO "${schemaName}"."${tableName}" (${colList}) VALUES (${placeholders}) RETURNING *`
      const result = await executeWithUserContext<any>(ctx.projectId, rls.userId, rls.isServiceRole, sql, bound.values, rls.role)
      if (result[0]) inserted.push(result[0])
    }

    // Non-blocking triggers + AI functions
    if (inserted.length > 0) {
      const { fireTriggers } = await import('@/lib/services/trigger-service')
      for (const row of inserted) {
        fireTriggers(ctx.projectId, { type: 'insert', table: tableName, data: row }).catch(
          (err: any) => console.warn('[Triggers] fire failed (non-fatal):', err?.message)
        )
      }
    }

    sendSuccess(res, { data: inserted.length === 1 ? inserted[0] : inserted })
  } catch (error: any) {
    if (sendRefusal(res, error, refusal)) return
    console.error('Database insert error:', error)
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to insert data', 500)
  }
}))

// ── POST /api/v1/:projectId/database/update ────────────────────────────────────

router.post('/:projectId/database/update', asyncRoute(v1AuthMiddleware), asyncRoute(async (req: Request, res: Response) => {
  const ctx = req.v1Context!

  if (!checkPermission(res, ctx, ['write', 'admin'])) return
  if (!checkCapability(res, ctx, '/database')) return

  const parsed = updateSchema.safeParse(req.body)
  if (!parsed.success) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'Request validation failed', 400, {
      fields: parsed.error.flatten().fieldErrors,
    })
    return
  }

  const { table, where, data } = parsed.data
  const tableName = table.toLowerCase()
  const schemaName = `workspace_${ctx.projectId}`
  // What was bound, so a refusal can name its column.
  let refusal: QueryContext | undefined

  try {
    // Catalog-truth existence gate (single source of truth). Servable iff the
    // table physically exists and is exposed — no prisma.table metadata record
    // required, so a freshly-created table works instantly and a dropped one
    // stops instantly. Was: prisma.table.findFirst (a metadata copy that drifts).
    if (!(await workspaceTableExists(ctx.projectId, tableName))) {
      sendError(res, ErrorCodes.NOT_FOUND, `Table '${table}' not found in this project`, 404)
      return
    }

    // A blocked end-user is answered 403 before anything in the request is read.
    const rls = await resolveRlsIdentity(req, ctx.projectId, ctx.apiKey.serviceRole)
    if (refuseIfBlocked(res, rls)) return

    const setCols = Object.keys(data).filter(c => /^[a-z_][a-z0-9_]*$/i.test(c))
    if (setCols.length === 0) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, 'No valid fields to update', 400)
      return
    }

    const types = await columnTypes(ctx.projectId, schemaName, tableName)
    const bound = typedParams(types)
    refusal = bound.context(tableName)
    const setParts = setCols.map(c => `"${c}" = ${bound.bind(c, data[c])}`)

    // WHERE params follow the SET params in the same sequence. Required, as for
    // delete and on the Next route: with none, every row the key can reach was
    // updated (an SDK update() with no filter sends no `where` at all).
    const whereClause = whereSql(where, bound, types)
    if (!whereClause) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, 'A WHERE condition is required for update', 400)
      return
    }

    const sql = `UPDATE "${schemaName}"."${tableName}" SET ${setParts.join(', ')} ${whereClause} RETURNING *`
    const result = await executeWithUserContext<any>(ctx.projectId, rls.userId, rls.isServiceRole, sql, bound.values, rls.role)

    if (result.length > 0) {
      const { fireTriggers } = await import('@/lib/services/trigger-service')
      for (const row of result) {
        fireTriggers(ctx.projectId, { type: 'update', table: tableName, data: row }).catch(
          (err: any) => console.warn('[Triggers] fire failed (non-fatal):', err?.message)
        )
      }
    }

    sendSuccess(res, { data: result.length === 1 ? result[0] : result, updated: result.length })
  } catch (error: any) {
    if (sendRefusal(res, error, refusal)) return
    console.error('Database update error:', error)
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to update data', 500)
  }
}))

// ── POST /api/v1/:projectId/database/delete ────────────────────────────────────

router.post('/:projectId/database/delete', asyncRoute(v1AuthMiddleware), asyncRoute(async (req: Request, res: Response) => {
  const ctx = req.v1Context!

  if (!checkPermission(res, ctx, ['write', 'admin'])) return
  if (!checkCapability(res, ctx, '/database')) return

  const parsed = deleteSchema.safeParse(req.body)
  if (!parsed.success) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'Request validation failed', 400, {
      fields: parsed.error.flatten().fieldErrors,
    })
    return
  }

  const { table, where } = parsed.data
  const tableName = table.toLowerCase()
  const schemaName = `workspace_${ctx.projectId}`
  // What was bound, so a refusal can name its column.
  let refusal: QueryContext | undefined

  try {
    // Catalog-truth existence gate (single source of truth). Servable iff the
    // table physically exists and is exposed — no prisma.table metadata record
    // required, so a freshly-created table works instantly and a dropped one
    // stops instantly. Was: prisma.table.findFirst (a metadata copy that drifts).
    if (!(await workspaceTableExists(ctx.projectId, tableName))) {
      sendError(res, ErrorCodes.NOT_FOUND, `Table '${table}' not found in this project`, 404)
      return
    }

    // A blocked end-user is answered 403 before anything in the request is read.
    const rls = await resolveRlsIdentity(req, ctx.projectId, ctx.apiKey.serviceRole)
    if (refuseIfBlocked(res, rls)) return

    const types = await columnTypes(ctx.projectId, schemaName, tableName)
    const bound = typedParams(types)
    refusal = bound.context(tableName)
    const whereClause = whereSql(where, bound, types)

    if (!whereClause) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, 'A WHERE condition is required for delete', 400)
      return
    }

    const sql = `DELETE FROM "${schemaName}"."${tableName}" ${whereClause} RETURNING *`
    const result = await executeWithUserContext<any>(ctx.projectId, rls.userId, rls.isServiceRole, sql, bound.values, rls.role)

    if (result.length > 0) {
      const { fireTriggers } = await import('@/lib/services/trigger-service')
      for (const row of result) {
        fireTriggers(ctx.projectId, { type: 'delete', table: tableName, data: row }).catch(
          (err: any) => console.warn('[Triggers] fire failed (non-fatal):', err?.message)
        )
      }
    }

    sendSuccess(res, { success: true, deleted: result.length })
  } catch (error: any) {
    if (sendRefusal(res, error, refusal)) return
    console.error('Database delete error:', error)
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to delete data', 500)
  }
}))

export default router

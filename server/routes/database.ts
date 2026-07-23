import { Router, Request, Response } from 'express'
import { prisma } from '@/lib/db'
import { v1AuthMiddleware, checkPermission, checkCapability } from '../lib/auth'
import { sendError, sendSuccess, ErrorCodes } from '../lib/response'
import { z } from 'zod'
import { executeWithUserContext } from '@/lib/services/workspace-rls'
import { resolveEndUserFromToken } from '../lib/end-user-identity'
import { applyIncludes, UnknownRelationError } from '@/lib/services/relational-include'
import { workspaceTableExists } from '@/lib/mcp/schema-introspection'

const router = Router()

// ── RLS identity ───────────────────────────────────────────────────────────────

interface RlsIdentity {
  userId: string
  isServiceRole: boolean
  role: string
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
  if (endUser) return { userId: endUser.userId, isServiceRole: false, role: endUser.role }
  return { userId: '', isServiceRole: false, role: 'user' }
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

// ── WHERE clause builder ───────────────────────────────────────────────────────

function buildWhere(where: Record<string, any> | undefined, startIdx = 1) {
  const parts: string[] = []
  const values: any[] = []
  let idx = startIdx

  if (where && typeof where === 'object') {
    for (const [col, val] of Object.entries(where)) {
      if (!/^[a-z_][a-z0-9_]*$/i.test(col)) continue
      if (val === null) {
        // SQL `= NULL` never matches — the SDK's isNull() serializes to null.
        parts.push(`"${col}" IS NULL`)
      } else if (typeof val === 'object') {
        const op = val as any
        if (op.gt !== undefined)  { parts.push(`"${col}" > $${idx++}`); values.push(op.gt) }
        if (op.gte !== undefined) { parts.push(`"${col}" >= $${idx++}`); values.push(op.gte) }
        if (op.lt !== undefined)  { parts.push(`"${col}" < $${idx++}`); values.push(op.lt) }
        if (op.lte !== undefined) { parts.push(`"${col}" <= $${idx++}`); values.push(op.lte) }
        if (op.not === null) {
          // SDK isNotNull() serializes to { not: null }.
          parts.push(`"${col}" IS NOT NULL`)
        } else if (op.not !== undefined) {
          parts.push(`"${col}" != $${idx++}`); values.push(op.not)
        }
        if (op.contains !== undefined) { parts.push(`"${col}"::text ILIKE $${idx++}`); values.push(`%${op.contains}%`) }
        if (op.in !== undefined && Array.isArray(op.in)) {
          const placeholders = op.in.map(() => `$${idx++}`).join(', ')
          parts.push(`"${col}" IN (${placeholders})`)
          values.push(...op.in)
        }
      } else {
        parts.push(`"${col}" = $${idx++}`)
        values.push(val)
      }
    }
  }
  return { clause: parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '', values, nextIdx: idx }
}

// ── POST /api/v1/:projectId/database/query ─────────────────────────────────────

router.post('/:projectId/database/query', v1AuthMiddleware, async (req: Request, res: Response) => {
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

  try {
    // Catalog-truth existence gate (single source of truth). Servable iff the
    // table physically exists and is exposed — no prisma.table metadata record
    // required, so a freshly-created table works instantly and a dropped one
    // stops instantly. Was: prisma.table.findFirst (a metadata copy that drifts).
    if (!(await workspaceTableExists(ctx.projectId, tableName))) {
      sendError(res, ErrorCodes.NOT_FOUND, `Table '${table}' not found in this project`, 404)
      return
    }

    const { clause: whereClause, values: whereValues } = buildWhere(where)

    let orderByClause = ''
    if (orderBy && typeof orderBy === 'object') {
      const parts = Object.entries(orderBy)
        .filter(([col]) => /^[a-z_][a-z0-9_]*$/i.test(col))
        .map(([col, dir]) => `"${col}" ${String(dir).toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`)
      if (parts.length > 0) orderByClause = `ORDER BY ${parts.join(', ')}`
    }

    const countSql = `SELECT COUNT(*)::int AS count FROM "${schemaName}"."${tableName}" ${whereClause}`
    const dataSql  = `SELECT * FROM "${schemaName}"."${tableName}" ${whereClause} ${orderByClause} LIMIT ${Number(limit)} OFFSET ${Number(offset)}`

    const rls = await resolveRlsIdentity(req, ctx.projectId, ctx.apiKey.serviceRole)
    const [countResult, rows] = await Promise.all([
      executeWithUserContext<{ count: number }>(rls.userId, rls.isServiceRole, countSql, whereValues, rls.role),
      executeWithUserContext<any>(rls.userId, rls.isServiceRole, dataSql, whereValues, rls.role),
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
    console.error('Database query error:', error)
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to execute database query', 500)
  }
})

// ── POST /api/v1/:projectId/database/insert ────────────────────────────────────

router.post('/:projectId/database/insert', v1AuthMiddleware, async (req: Request, res: Response) => {
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
    for (const row of rows) {
      const cols = Object.keys(row).filter(c => /^[a-z_][a-z0-9_]*$/i.test(c))
      if (cols.length === 0) continue
      const colList = cols.map(c => `"${c}"`).join(', ')
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ')
      const values = cols.map(c => row[c])
      const sql = `INSERT INTO "${schemaName}"."${tableName}" (${colList}) VALUES (${placeholders}) RETURNING *`
      const result = await executeWithUserContext<any>(rls.userId, rls.isServiceRole, sql, values, rls.role)
      if (result[0]) inserted.push(result[0])
    }

    // Non-blocking triggers + AI functions
    if (inserted.length > 0) {
      const { fireTriggers } = await import('@/lib/services/trigger-service')
      const { fireAiFunctions } = await import('@/lib/services/ai-functions/executor')
      for (const row of inserted) {
        fireTriggers(ctx.projectId, { type: 'insert', table: tableName, data: row }).catch(
          (err: any) => console.warn('[Triggers] fire failed (non-fatal):', err?.message)
        )
        fireAiFunctions(ctx.projectId, { type: 'insert', table: tableName, data: row }).catch(
          (err: any) => console.warn('[AiFunctions] fire failed (non-fatal):', err?.message)
        )
      }
    }

    sendSuccess(res, { data: inserted.length === 1 ? inserted[0] : inserted })
  } catch (error: any) {
    console.error('Database insert error:', error)
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to insert data', 500)
  }
})

// ── POST /api/v1/:projectId/database/update ────────────────────────────────────

router.post('/:projectId/database/update', v1AuthMiddleware, async (req: Request, res: Response) => {
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

  try {
    // Catalog-truth existence gate (single source of truth). Servable iff the
    // table physically exists and is exposed — no prisma.table metadata record
    // required, so a freshly-created table works instantly and a dropped one
    // stops instantly. Was: prisma.table.findFirst (a metadata copy that drifts).
    if (!(await workspaceTableExists(ctx.projectId, tableName))) {
      sendError(res, ErrorCodes.NOT_FOUND, `Table '${table}' not found in this project`, 404)
      return
    }

    const setCols = Object.keys(data).filter(c => /^[a-z_][a-z0-9_]*$/i.test(c))
    if (setCols.length === 0) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, 'No valid fields to update', 400)
      return
    }

    const values: any[] = []
    let idx = 1
    const setParts = setCols.map(c => { values.push(data[c]); return `"${c}" = $${idx++}` })

    // WHERE params start after the SET params; buildWhere numbers them and
    // supports the full operator vocabulary (gt/lt/in/contains/null/…).
    const { clause: whereClause, values: whereValues } = buildWhere(where, idx)
    values.push(...whereValues)

    const sql = `UPDATE "${schemaName}"."${tableName}" SET ${setParts.join(', ')} ${whereClause} RETURNING *`
    const rls = await resolveRlsIdentity(req, ctx.projectId, ctx.apiKey.serviceRole)
    const result = await executeWithUserContext<any>(rls.userId, rls.isServiceRole, sql, values, rls.role)

    if (result.length > 0) {
      const { fireTriggers } = await import('@/lib/services/trigger-service')
      const { fireAiFunctions } = await import('@/lib/services/ai-functions/executor')
      for (const row of result) {
        fireTriggers(ctx.projectId, { type: 'update', table: tableName, data: row }).catch(
          (err: any) => console.warn('[Triggers] fire failed (non-fatal):', err?.message)
        )
        fireAiFunctions(ctx.projectId, { type: 'update', table: tableName, data: row }).catch(
          (err: any) => console.warn('[AiFunctions] fire failed (non-fatal):', err?.message)
        )
      }
    }

    sendSuccess(res, { data: result.length === 1 ? result[0] : result, updated: result.length })
  } catch (error: any) {
    console.error('Database update error:', error)
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to update data', 500)
  }
})

// ── POST /api/v1/:projectId/database/delete ────────────────────────────────────

router.post('/:projectId/database/delete', v1AuthMiddleware, async (req: Request, res: Response) => {
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

  try {
    // Catalog-truth existence gate (single source of truth). Servable iff the
    // table physically exists and is exposed — no prisma.table metadata record
    // required, so a freshly-created table works instantly and a dropped one
    // stops instantly. Was: prisma.table.findFirst (a metadata copy that drifts).
    if (!(await workspaceTableExists(ctx.projectId, tableName))) {
      sendError(res, ErrorCodes.NOT_FOUND, `Table '${table}' not found in this project`, 404)
      return
    }

    const { clause: whereClause, values } = buildWhere(where)

    if (!whereClause) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, 'A WHERE condition is required for delete', 400)
      return
    }

    const sql = `DELETE FROM "${schemaName}"."${tableName}" ${whereClause} RETURNING id`
    const rls = await resolveRlsIdentity(req, ctx.projectId, ctx.apiKey.serviceRole)
    const result = await executeWithUserContext<any>(rls.userId, rls.isServiceRole, sql, values, rls.role)

    if (result.length > 0) {
      const { fireTriggers } = await import('@/lib/services/trigger-service')
      const { fireAiFunctions } = await import('@/lib/services/ai-functions/executor')
      for (const row of result) {
        fireTriggers(ctx.projectId, { type: 'delete', table: tableName, data: row }).catch(
          (err: any) => console.warn('[Triggers] fire failed (non-fatal):', err?.message)
        )
        fireAiFunctions(ctx.projectId, { type: 'delete', table: tableName, data: row }).catch(
          (err: any) => console.warn('[AiFunctions] fire failed (non-fatal):', err?.message)
        )
      }
    }

    sendSuccess(res, { success: true, deleted: result.length })
  } catch (error: any) {
    console.error('Database delete error:', error)
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to delete data', 500)
  }
})

export default router

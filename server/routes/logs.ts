/**
 * Logs API — Express version.
 *
 * GET /api/v1/:projectId/logs
 */

import { Router, Request, Response } from 'express'
import { prisma } from '@/lib/db'
import { v1AuthMiddleware, checkPermission, checkCapability } from '../lib/auth'
import { sendError, sendSuccess, ErrorCodes } from '../lib/response'

const router = Router()

router.get('/:projectId/logs', v1AuthMiddleware, async (req: Request, res: Response) => {
  const ctx = req.v1Context!

  if (!checkPermission(res, ctx, ['read', 'admin'])) return
  if (!checkCapability(res, ctx, '/logs')) return

  try {
    const type = req.query.type as string | undefined
    const severity = req.query.severity as string | undefined
    const limit = parseInt((req.query.limit as string) || '100', 10)
    const offset = parseInt((req.query.offset as string) || '0', 10)
    const startTime = req.query.startTime as string | undefined
    const endTime = req.query.endTime as string | undefined

    const where: any = { projectId: ctx.projectId }
    if (type) where.type = type
    if (severity) where.severity = severity
    if (startTime || endTime) {
      where.createdAt = {}
      if (startTime) where.createdAt.gte = new Date(startTime)
      if (endTime) where.createdAt.lte = new Date(endTime)
    }

    const [logs, total] = await Promise.all([
      prisma.log.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        select: { id: true, type: true, severity: true, message: true, metadata: true, createdAt: true },
      }),
      prisma.log.count({ where }),
    ])

    sendSuccess(res, logs, {
      limit,
      page: Math.floor(offset / limit),
      total,
      hasMore: offset + logs.length < total,
    })
  } catch (error: any) {
    console.error('Logs fetch error:', error)
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to fetch logs', 500)
  }
})

export default router

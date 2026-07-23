/**
 * Trigger Management API — Express version.
 * Uses platform JWT cookie auth (not API key auth).
 *
 * GET    /api/v1/:projectId/triggers
 * POST   /api/v1/:projectId/triggers
 * DELETE /api/v1/:projectId/triggers?id=
 */

import { Router, Request, Response } from 'express'
import { verifyToken } from '@/lib/auth/jwt'
import { prisma } from '@/lib/db'
import { listTriggers, createTrigger, deleteTrigger } from '@/lib/services/trigger-service'
import { enforceTriggerCreation } from '@/lib/billing'

const router = Router()

async function authenticate(req: Request, projectId: string) {
  // Cookie-based platform JWT auth
  const cookieHeader = req.headers.cookie || ''
  const match = cookieHeader.match(/(?:^|;\s*)auth-token=([^;]+)/)
  const token = match ? decodeURIComponent(match[1]) : null

  if (!token) return { error: 'Unauthorized' }

  let decoded: any = null
  try {
    decoded = await verifyToken(token)
  } catch {
    return { error: 'Invalid token' }
  }

  if (!decoded) return { error: 'Invalid token' }

  const project = await prisma.project.findFirst({
    where: { id: projectId, userId: decoded.userId },
  })
  if (!project) return { error: 'Project not found or access denied' }

  return { userId: decoded.userId }
}

router.get('/:projectId/triggers', async (req: Request, res: Response) => {
  const auth = await authenticate(req, req.params.projectId)
  if ('error' in auth) {
    res.status(401).json({ error: auth.error })
    return
  }
  const triggers = await listTriggers(req.params.projectId)
  res.json({ triggers })
})

router.post('/:projectId/triggers', async (req: Request, res: Response) => {
  const { projectId } = req.params
  const auth = await authenticate(req, projectId)
  if ('error' in auth) {
    res.status(401).json({ error: auth.error })
    return
  }

  const { name, description, sourceTable, event, conditions, actionType, targetTable, fieldMappings, staticFields, webhookUrl } = req.body

  if (!name || !sourceTable || !event || !actionType) {
    res.status(400).json({ error: 'name, sourceTable, event, and actionType are required' })
    return
  }

  try {
    const currentTriggerCount = await prisma.appTrigger.count({ where: { projectId } })
    const triggerCheck = await enforceTriggerCreation(auth.userId, projectId, currentTriggerCount)
    if (triggerCheck !== true) {
      res.status(403).json({
        error: (triggerCheck as any).message,
        code: (triggerCheck as any).code,
        upgradeRequired: (triggerCheck as any).upgradeRequired,
        currentPlan: (triggerCheck as any).currentPlan,
        requiredPlan: (triggerCheck as any).requiredPlan,
      })
      return
    }

    const trigger = await createTrigger(projectId, {
      name, description, sourceTable, event, conditions,
      actionType, targetTable, fieldMappings, staticFields, webhookUrl,
    })
    res.status(201).json({ trigger })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

router.delete('/:projectId/triggers', async (req: Request, res: Response) => {
  const { projectId } = req.params
  const auth = await authenticate(req, projectId)
  if ('error' in auth) {
    res.status(401).json({ error: auth.error })
    return
  }

  const triggerId = req.query.id as string
  if (!triggerId) {
    res.status(400).json({ error: 'id query parameter is required' })
    return
  }

  try {
    await deleteTrigger(projectId, triggerId)
    res.json({ success: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

export default router

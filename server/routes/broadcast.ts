/**
 * Broadcast API — Express version.
 * Sends an ephemeral pg_notify event to all SSE subscribers for a project.
 *
 * POST /api/v1/:projectId/broadcast
 *
 * SECURITY: requires a valid project API key.
 */

import { Router, Request, Response } from 'express'
import { prisma } from '@/lib/db'
import { v1AuthMiddleware } from '../lib/auth'
import { workspaceChannelName } from '@/lib/security/workspace-schema'

const router = Router()

const MAX_PAYLOAD_BYTES = 6_000
const CHANNEL_RE = /^[a-zA-Z0-9_-]{1,64}$/

router.post('/:projectId/broadcast', v1AuthMiddleware, async (req: Request, res: Response) => {
  const { projectId } = req.params
  const { channel, payload = {} } = req.body

  try {
    if (!channel || typeof channel !== 'string') {
      res.status(400).json({ error: 'channel is required' })
      return
    }
    if (!CHANNEL_RE.test(channel)) {
      res.status(400).json({
        error: 'channel must be 1–64 alphanumeric characters (hyphens and underscores allowed)',
      })
      return
    }

    let notifyChannel: string
    try {
      notifyChannel = workspaceChannelName(projectId)
    } catch {
      res.status(400).json({ error: 'Invalid project ID' })
      return
    }

    const notifyPayload = JSON.stringify({
      type: 'broadcast',
      channel,
      payload,
      timestamp: Date.now() / 1000,
    })

    if (Buffer.byteLength(notifyPayload, 'utf8') > MAX_PAYLOAD_BYTES) {
      res.status(413).json({ error: 'payload too large (max ~6 KB)' })
      return
    }

    await prisma.$executeRawUnsafe(`SELECT pg_notify($1, $2)`, notifyChannel, notifyPayload)

    res.json({ success: true })
  } catch (err: any) {
    res.status(500).json({ error: 'Broadcast failed' })
  }
})

export default router

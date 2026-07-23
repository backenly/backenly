/**
 * Realtime SSE route — Express version. This is the route nginx serves for
 * /api/v1 in production.
 *
 * Fan-out goes through the shared ListenerHub (lib/realtime/listener-hub.ts):
 * ONE direct pg LISTEN connection per process, any number of SSE subscribers.
 * A subscriber costs zero database connections — the previous
 * connection-per-client design hit Postgres max_connections (~100) at scale
 * and could take down the whole platform.
 *
 * PLAN GATING: the hub enforces the owner's plan cap on concurrent
 * connections (Free 25 / Pro 1,000 / Enterprise custom). A blocked connect gets a
 * single `{ type: "error", code: "PLAN_LIMIT_EXCEEDED" }` frame and the
 * stream closes — SDK clients treat that code as fatal and stop retrying.
 *
 * GET /api/v1/:projectId/realtime?table=optional_filter
 *
 * SECURITY: requires a valid project API key (x-api-key or Bearer). UUID
 * obscurity is not auth — without this, anyone with a project UUID could
 * stream every database change in real time.
 */

import { Router, Request, Response } from 'express'
import { v1AuthMiddleware } from '../lib/auth'
import { listenerHub } from '@/lib/realtime/listener-hub'

const router = Router()

router.get('/:projectId/realtime', v1AuthMiddleware, async (req: Request, res: Response) => {
  const { projectId } = req.params
  const tableFilter = req.query.table as string | undefined

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const send = (data: object) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`) } catch { /* client gone */ }
  }
  const sendComment = (comment: string) => {
    try { res.write(`: ${comment}\n\n`) } catch { /* client gone */ }
  }

  let subscription: { unsubscribe: () => void } | null = null
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null
  let closed = false

  const cleanup = () => {
    if (closed) return
    closed = true
    if (keepaliveTimer) clearInterval(keepaliveTimer)
    subscription?.unsubscribe()
    subscription = null
    try { res.end() } catch { /* already ended */ }
  }

  req.on('close', cleanup)

  try {
    const result = await listenerHub.subscribe(projectId, (payload) => {
      if (!tableFilter || payload.table === tableFilter) {
        send(payload)
      }
    })

    if (result.ok === false) {
      send({ type: 'error', code: result.code, message: result.message })
      cleanup()
      return
    }
    subscription = result

    send({ type: 'connected', projectId, channel: result.channel })

    // Keepalive comment every 25 s to prevent proxy/CDN idle timeouts.
    keepaliveTimer = setInterval(() => {
      if (!closed) sendComment('keepalive')
    }, 25_000)
  } catch (err: any) {
    console.warn('[Realtime SSE] subscribe failed:', err?.message)
    send({ type: 'error', message: 'Failed to connect to realtime stream' })
    cleanup()
  }
})

export default router

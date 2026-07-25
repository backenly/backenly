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

import { Router, Request, Response, NextFunction } from 'express'
import { v1AuthMiddleware } from '../lib/auth'
import { listenerHub } from '@/lib/realtime/listener-hub'
import { redeemRealtimeTicketParam } from '@/lib/realtime/ticket-auth'
import { mintSseTicket, SSE_TICKET_TTL_SECONDS } from '@/lib/realtime/sse-ticket'
import { resolveJwtSecret } from '@/lib/services/jwtSecretManager'
import { prisma } from '@/lib/db/prisma'

const router = Router()

/**
 * Accept a short-lived single-use `?ticket=`, else fall through to API-key auth.
 *
 * `EventSource` cannot send headers, so a browser client must put its credential
 * in the URL — and a URL is the worst place for a long-lived one (nginx access
 * logs, proxy logs, browser history, Referer). A ticket is the credential built
 * for that position: 30 seconds, one connection, signed with the project's own
 * secret. `?apiKey=` still works for existing clients and is deprecated.
 */
async function realtimeAuth(req: Request, res: Response, next: NextFunction) {
  const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : ''
  if (!ticket) return v1AuthMiddleware(req, res, next)

  const redeemed = await redeemRealtimeTicketParam(req.params.projectId, ticket)
  // `=== false` narrows under `strict: false`; `!redeemed.ok` does not.
  if (redeemed.ok === false) {
    res.status(401).json({ error: redeemed.message, code: redeemed.code })
    return
  }
  next()
}

router.get('/:projectId/realtime', realtimeAuth, async (req: Request, res: Response) => {
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

/**
 * POST /api/v1/:projectId/realtime/ticket
 *
 * Mints the ticket the route above prefers. Auth is by HEADER here — that is the
 * whole point: the end-user's session JWT is exchanged for something disposable
 * before anything reaches a query string. Mirrors
 * app/api/v1/[projectId]/realtime/ticket/route.ts; nginx serves this one in prod.
 */
router.post('/:projectId/realtime/ticket', v1AuthMiddleware, async (req: Request, res: Response) => {
  const { projectId } = req.params
  const project = await prisma.project
    .findUnique({ where: { id: projectId }, select: { jwtSecret: true } })
    .catch(() => null)

  if (!project?.jwtSecret) {
    res.status(409).json({
      error:
        'This project has no JWT signing secret yet, so realtime tickets cannot be issued. ' +
        'Enable end-user auth first — the ticket is signed with the project secret so it can never ' +
        'be replayed against another project.',
      code: 'NO_PROJECT_SECRET',
    })
    return
  }

  const ctx = (req as any).v1Context ?? {}
  const minted = await mintSseTicket(resolveJwtSecret(project.jwtSecret), {
    projectId,
    keyId: ctx.apiKey?.id ?? null,
    endUserId: ctx.endUserId ?? null,
    endUserRole: ctx.endUserRole ?? null,
    serviceRole: !!ctx.apiKey?.serviceRole,
  })

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private')
  res.json({
    ticket: minted.ticket,
    expiresIn: minted.expiresIn,
    singleUse: minted.singleUse,
    endUserId: ctx.endUserId ?? null,
    connect: `GET /api/v1/${projectId}/realtime?ticket=<ticket>`,
    ...(minted.singleUse
      ? {}
      : {
          warning:
            'Single-use could not be armed (the redemption ledger was unreachable). This ticket is still ' +
            `project-scoped and still expires in ${SSE_TICKET_TTL_SECONDS}s, but it is replayable inside ` +
            'that window.',
        }),
  })
})

export default router

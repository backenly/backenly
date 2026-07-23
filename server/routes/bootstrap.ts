/**
 * Bootstrap route — origin-based handshake for the SDK.
 *
 * Mirrors app/api/v1/[projectId]/bootstrap/route.ts but lives here because
 * nginx routes ALL /api/v1/* traffic to the Express runtime (port 3001).
 * Without a route here, the Next.js bootstrap is unreachable in prod.
 *
 * GET /api/v1/:projectId/bootstrap
 *   Returns the project's public anon key so the SDK can authenticate every
 *   subsequent call without the developer ever pasting a key into their
 *   frontend bundle. See route comments in the Next.js twin for the full
 *   security model — same posture: anon keys are public by design, project
 *   IDs are public, rate-limited per (project, IP).
 */

import { Router, Request, Response } from 'express'
import { createHash } from 'crypto'
import { prisma } from '@/lib/db'
import { generateApiKey } from '@/lib/auth/apiKeyAuth'
import { recordSecurityEvent, getPlatformControls } from '@/lib/platform/controls'
import { sendError, sendSuccess, ErrorCodes } from '../lib/response'

const router = Router()

// ── In-memory per-(project, IP) rate limit ─────────────────────────────────
const RATE_LIMIT = 120
const WINDOW_MS = 60_000
const buckets = new Map<string, { count: number; resetAt: number }>()

function checkRateLimit(key: string): { allowed: true } | { allowed: false; retryAfter: number } {
  const now = Date.now()
  const b = buckets.get(key)
  if (!b || b.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS })
    return { allowed: true }
  }
  if (b.count >= RATE_LIMIT) {
    return { allowed: false, retryAfter: Math.ceil((b.resetAt - now) / 1000) }
  }
  b.count += 1
  return { allowed: true }
}

setInterval(() => {
  const now = Date.now()
  for (const [k, b] of buckets) if (b.resetAt < now) buckets.delete(k)
}, WINDOW_MS).unref?.()

router.get('/:projectId/bootstrap', async (req: Request, res: Response) => {
  const projectId = req.params.projectId

  if (!projectId || !/^[a-z0-9-]{8,64}$/i.test(projectId)) {
    return sendError(res, ErrorCodes.BAD_REQUEST, 'Invalid project ID', 400)
  }

  const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
    ?? (req.headers['x-real-ip'] as string | undefined)
    ?? req.socket?.remoteAddress
    ?? 'unknown'

  const rl = checkRateLimit(`${projectId}:${ip}`)
  if (rl.allowed === false) {
    res.setHeader('Retry-After', String(rl.retryAfter))
    return sendError(
      res,
      ErrorCodes.RATE_LIMIT_EXCEEDED,
      'Too many bootstrap requests. Try again shortly.',
      429,
    )
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      name: true,
      userId: true,
      anonKey: true,
      lockedDownAt: true,
    },
  })

  if (!project) {
    return sendError(res, ErrorCodes.NOT_FOUND, 'Project not found', 404)
  }

  if (project.lockedDownAt) {
    return sendError(
      res,
      ErrorCodes.FORBIDDEN,
      'This project is currently locked by the platform operator. Contact support.',
      503,
    )
  }

  const controls = await getPlatformControls()
  if (controls.maintenanceMode) {
    return sendError(
      res,
      ErrorCodes.FORBIDDEN,
      'Platform is in maintenance mode. Try again shortly.',
      503,
    )
  }

  let anonKey = project.anonKey

  if (!anonKey) {
    anonKey = generateApiKey('live')
    const keyHash = createHash('sha256').update(anonKey).digest('hex')
    const keyPrefix = anonKey.substring(0, 16)

    try {
      await prisma.$transaction([
        prisma.apiKey.create({
          data: {
            name: 'Public Anon Key',
            keyHash,
            keyPrefix,
            projectId,
            userId: project.userId,
            permissions: ['read', 'write'],
            rateLimit: 1000,
            keyType: 'public',
            serviceRole: false,
          },
        }),
        prisma.project.update({
          where: { id: projectId },
          data: { anonKey },
        }),
      ])
    } catch (err) {
      console.error('[Bootstrap] Failed to provision anon key:', (err as Error)?.message)
      return sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to provision anon key', 500)
    }
  }

  const origin = (req.headers['origin'] as string | undefined)
    ?? (req.headers['referer'] as string | undefined)
    ?? null

  recordSecurityEvent({
    kind: 'bootstrap',
    severity: 'info',
    projectId,
    userId: project.userId,
    ip,
    summary: `Bootstrap completed from ${origin ?? 'unknown origin'}`,
    detail: {
      origin,
      userAgent: req.headers['user-agent'] ?? null,
      provisioned: !project.anonKey,
    },
  }).catch(() => {})

  prisma.project
    .update({ where: { id: projectId }, data: { isFrontendConnected: true } })
    .catch(() => {})

  // Permissive CORS — bootstrap is called from arbitrary frontend origins.
  // The body carries only the public anon key.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'no-store')

  return sendSuccess(res, {
    projectId: project.id,
    projectName: project.name,
    anonKey,
    apiUrl: 'https://backenly.com',
  })
})

// CORS preflight for bootstrap (arbitrary origins).
router.options('/:projectId/bootstrap', (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type, accept')
  res.setHeader('Access-Control-Max-Age', '86400')
  res.status(204).end()
})

export default router

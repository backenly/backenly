/**
 * Presence API — Express version.
 * Tracks which users are online in a project.
 * Uses _backenly_presence table in workspace_{projectId} schema.
 *
 * GET    /api/v1/:projectId/presence  — list online users
 * POST   /api/v1/:projectId/presence  — join / heartbeat
 * DELETE /api/v1/:projectId/presence  — leave
 *
 * SECURITY: All routes require a valid project API key. Schema name comes
 * from the centralized workspaceSchemaName() helper which hard-validates
 * the projectId as a UUID. Writes additionally bind the presence identity:
 * see presenceIdentityError below.
 */

import { Router, Request, Response } from 'express'
import rateLimit from 'express-rate-limit'
import { workspaceRawClient } from '@/lib/data-plane/regional'
import { ensurePresenceTable } from '@/lib/realtime/presence-store'
import { v1AuthMiddleware, v1PresenceAuthMiddleware } from '../lib/auth'
import { clientIpFromNodeRequest } from '@/lib/security/client-ip'
import {
  PRESENCE_WRITES_PER_ADDRESS_PER_MINUTE,
  countPresenceWrite,
  platformLimiterStore,
  presenceAddressBucket,
  presenceRefusal,
} from '@/lib/security/shared-key-rate'
import { resolveEndUserFromToken } from '../lib/end-user-identity'
import { workspaceSchemaName, quoteIdent } from '@/lib/security/workspace-schema'
import { presenceMetadataTooLarge } from '@/lib/realtime/presence-metadata'
import { asyncRoute } from '../lib/async-route'

const router = Router()

const PRESENCE_TTL_SECONDS = 60

/**
 * Who may act as `userId`? Presence names are identities, not labels: a row
 * here renders as "that user is online" in every subscribed client. These
 * handlers used to take userId from the body unchecked, so any holder of the
 * public anon key could mark ANY user online with arbitrary metadata, or kick
 * anyone offline. The rule now matches the data plane's:
 *   - service-role key          → any userId (trusted server-side caller)
 *   - public key + X-User-Token → only the token's own userId
 *   - public key, no token      → refused, with the remedy named
 * Metadata stays client-supplied display data — the IDENTITY is what gets
 * bound; the metadata is what the signed-in user chose to show.
 */
async function presenceIdentityError(
  req: Request,
  projectId: string,
  userId: string,
): Promise<{ status: number; body: { error: string; code: string } } | null> {
  if (req.v1Context?.apiKey.serviceRole) return null
  const identity = await resolveEndUserFromToken(
    projectId,
    req.headers['x-user-token'] as string | undefined,
  )
  // A blocked user's token still verifies, but blocking promises it stops
  // working: refuse it as the data routes do, never read it as a sign-in.
  if (identity === 'blocked') {
    return {
      status: 403,
      body: { error: 'This account has been blocked by the project owner.', code: 'END_USER_BLOCKED' },
    }
  }
  if (identity) {
    if (identity.userId === userId) return null
    return {
      status: 403,
      body: {
        error: 'The signed-in user may only announce or clear presence as themselves.',
        code: 'PRESENCE_IDENTITY_MISMATCH',
      },
    }
  }
  return {
    status: 401,
    body: {
      error:
        "Presence identifies callers by their sign-in. Send the end user's X-User-Token " +
        'together with the public key, or use a service-role key for server-side presence.',
      code: 'PRESENCE_TOKEN_REQUIRED',
    },
  }
}

/**
 * A presence write spends nothing of the key's limit, or a heartbeat every 25
 * seconds from every open tab would: it is counted per user instead, once the
 * caller may write as that user (lib/security/shared-key-rate.ts). Answers 429
 * and returns true when the user's window is full.
 */
async function refuseWhenPresenceWindowFull(req: Request, res: Response, userId: string): Promise<boolean> {
  const decision = await countPresenceWrite(req.v1Context!.apiKey.id, userId)
  if (decision.allowed) return false
  const refusal = presenceRefusal(decision, 'user')
  res.set(refusal.headers).status(refusal.status).json(refusal.body)
  return true
}

/**
 * Presence writes from one address to one project, counted before the key is
 * looked up, in the window the Next route counts too: a flood of them, signed
 * in or not, stops here, and none spends the key's limit.
 */
const presenceWritesFromAnAddress = rateLimit({
  windowMs: 60_000,
  limit: PRESENCE_WRITES_PER_ADDRESS_PER_MINUTE,
  keyGenerator: (req) => presenceAddressBucket(req.params.projectId, clientIpFromNodeRequest(req)),
  store: platformLimiterStore(PRESENCE_WRITES_PER_ADDRESS_PER_MINUTE, 60_000),
  standardHeaders: false,
  legacyHeaders: false,
  // The address comes from lib/security/client-ip.ts, never from req.ip.
  validate: { ip: false, trustProxy: false, xForwardedForHeader: false },
  handler: (req, res) => {
    const resetAt = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime ?? new Date(Date.now() + 60_000)
    const retryAfter = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000))
    const refusal = presenceRefusal({ allowed: false, remaining: 0, resetAt, retryAfter }, 'address')
    res.set(refusal.headers).status(refusal.status).json(refusal.body)
  },
})

router.get('/:projectId/presence', asyncRoute(v1AuthMiddleware), asyncRoute(async (req: Request, res: Response) => {
  const { projectId } = req.params
  try {
    const qSchema = quoteIdent(workspaceSchemaName(projectId))
    // The project's database, in its region, whose trigger NOTIFYs the channel
    // its listeners hear (lib/realtime/listener-hub.ts).
    const db = await workspaceRawClient(projectId)
    await ensurePresenceTable(db, projectId)
    const users = await db.$queryRawUnsafe<any[]>(
      `SELECT "userId", "metadata", "joinedAt", "lastSeen"
       FROM ${qSchema}."_backenly_presence"
       WHERE "lastSeen" > now() - interval '${PRESENCE_TTL_SECONDS} seconds'
       ORDER BY "joinedAt" ASC`
    )
    res.json({ users })
  } catch {
    res.status(500).json({ error: 'Presence lookup failed' })
  }
}))

router.post('/:projectId/presence', asyncRoute(presenceWritesFromAnAddress), asyncRoute(v1PresenceAuthMiddleware), asyncRoute(async (req: Request, res: Response) => {
  const { projectId } = req.params
  try {
    const qSchema = quoteIdent(workspaceSchemaName(projectId))
    // The project's database, in its region, whose trigger NOTIFYs the channel
    // its listeners hear (lib/realtime/listener-hub.ts).
    const db = await workspaceRawClient(projectId)
    const { userId, metadata = {} } = req.body

    if (!userId || typeof userId !== 'string') {
      res.status(400).json({ error: 'userId is required' })
      return
    }
    if (userId.length > 255) {
      res.status(400).json({ error: 'userId too long (max 255)' })
      return
    }
    // Refused here, not by pg_notify in the trigger, where it failed the upsert with a 500.
    const tooLarge = presenceMetadataTooLarge(metadata)
    if (tooLarge) {
      res.status(tooLarge.status).json(tooLarge.body)
      return
    }

    const identityError = await presenceIdentityError(req, projectId, userId)
    if (identityError) {
      res.status(identityError.status).json(identityError.body)
      return
    }
    if (await refuseWhenPresenceWindowFull(req, res, userId)) return

    await ensurePresenceTable(db, projectId)

    await db.$executeRawUnsafe(
      `INSERT INTO ${qSchema}."_backenly_presence" ("userId", "metadata", "lastSeen")
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT ("userId") DO UPDATE SET "lastSeen" = now(), "metadata" = EXCLUDED."metadata"`,
      userId, JSON.stringify(metadata)
    )

    await db.$executeRawUnsafe(
      `DELETE FROM ${qSchema}."_backenly_presence"
       WHERE "lastSeen" < now() - interval '${PRESENCE_TTL_SECONDS} seconds'`
    )

    res.json({ success: true })
  } catch {
    res.status(500).json({ error: 'Presence update failed' })
  }
}))

router.delete('/:projectId/presence', asyncRoute(presenceWritesFromAnAddress), asyncRoute(v1PresenceAuthMiddleware), asyncRoute(async (req: Request, res: Response) => {
  const { projectId } = req.params
  try {
    const qSchema = quoteIdent(workspaceSchemaName(projectId))
    // The project's database, in its region, whose trigger NOTIFYs the channel
    // its listeners hear (lib/realtime/listener-hub.ts).
    const db = await workspaceRawClient(projectId)
    let userId = (req.query.userId as string) || req.body?.userId || null

    if (!userId) {
      res.status(400).json({ error: 'userId is required' })
      return
    }

    const identityError = await presenceIdentityError(req, projectId, userId)
    if (identityError) {
      res.status(identityError.status).json(identityError.body)
      return
    }
    if (await refuseWhenPresenceWindowFull(req, res, userId)) return

    await ensurePresenceTable(db, projectId)

    await db.$executeRawUnsafe(
      `DELETE FROM ${qSchema}."_backenly_presence" WHERE "userId" = $1`,
      userId
    )

    res.json({ success: true })
  } catch {
    res.status(500).json({ error: 'Presence delete failed' })
  }
}))

export default router

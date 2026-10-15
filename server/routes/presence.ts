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
import { workspaceRawClient, type WorkspaceRawClient } from '@/lib/data-plane/regional'
import { v1AuthMiddleware } from '../lib/auth'
import { resolveEndUserFromToken } from '../lib/end-user-identity'
import { workspaceSchemaName, workspaceChannelName, quoteIdent } from '@/lib/security/workspace-schema'
import { asyncRoute } from '../lib/async-route'

const router = Router()

const PRESENCE_TTL_SECONDS = 60
const bootstrappedProjects = new Set<string>()

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

async function ensurePresenceTable(db: WorkspaceRawClient, projectId: string): Promise<void> {
  if (bootstrappedProjects.has(projectId)) return

  const schema = workspaceSchemaName(projectId)
  const channel = workspaceChannelName(projectId)
  const qSchema = quoteIdent(schema)

  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS ${qSchema}."_backenly_presence" (
      "userId"   TEXT        NOT NULL PRIMARY KEY,
      "metadata" JSONB       NOT NULL DEFAULT '{}',
      "joinedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "lastSeen" TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  await db.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION ${qSchema}.backenly_notify_presence()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        PERFORM pg_notify(
          '${channel}',
          json_build_object('type','presence','event','leave','userId',OLD."userId",'timestamp',extract(epoch from clock_timestamp()))::text
        );
        RETURN OLD;
      ELSIF TG_OP = 'INSERT' THEN
        PERFORM pg_notify(
          '${channel}',
          json_build_object('type','presence','event','join','userId',NEW."userId",'metadata',NEW."metadata",'timestamp',extract(epoch from clock_timestamp()))::text
        );
        RETURN NEW;
      ELSE
        IF NEW."metadata"::text IS DISTINCT FROM OLD."metadata"::text THEN
          PERFORM pg_notify(
            '${channel}',
            json_build_object('type','presence','event','update','userId',NEW."userId",'metadata',NEW."metadata",'timestamp',extract(epoch from clock_timestamp()))::text
          );
        END IF;
        RETURN NEW;
      END IF;
    END;
    $$
  `)

  await db.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS backenly_presence_notify ON ${qSchema}."_backenly_presence"
  `)
  await db.$executeRawUnsafe(`
    CREATE TRIGGER backenly_presence_notify
      AFTER INSERT OR UPDATE OR DELETE ON ${qSchema}."_backenly_presence"
      FOR EACH ROW EXECUTE FUNCTION ${qSchema}.backenly_notify_presence()
  `)

  bootstrappedProjects.add(projectId)
}

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

router.post('/:projectId/presence', asyncRoute(v1AuthMiddleware), asyncRoute(async (req: Request, res: Response) => {
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

    const identityError = await presenceIdentityError(req, projectId, userId)
    if (identityError) {
      res.status(identityError.status).json(identityError.body)
      return
    }

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

router.delete('/:projectId/presence', asyncRoute(v1AuthMiddleware), asyncRoute(async (req: Request, res: Response) => {
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

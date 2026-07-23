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
 * the projectId as a UUID.
 */

import { Router, Request, Response } from 'express'
import { prisma } from '@/lib/db'
import { v1AuthMiddleware } from '../lib/auth'
import { workspaceSchemaName, workspaceChannelName, quoteIdent } from '@/lib/security/workspace-schema'

const router = Router()

const PRESENCE_TTL_SECONDS = 60
const bootstrappedProjects = new Set<string>()

async function ensurePresenceTable(projectId: string): Promise<void> {
  if (bootstrappedProjects.has(projectId)) return

  const schema = workspaceSchemaName(projectId)
  const channel = workspaceChannelName(projectId)
  const qSchema = quoteIdent(schema)

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS ${qSchema}."_backenly_presence" (
      "userId"   TEXT        NOT NULL PRIMARY KEY,
      "metadata" JSONB       NOT NULL DEFAULT '{}',
      "joinedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "lastSeen" TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  await prisma.$executeRawUnsafe(`
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

  await prisma.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS backenly_presence_notify ON ${qSchema}."_backenly_presence"
  `)
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER backenly_presence_notify
      AFTER INSERT OR UPDATE OR DELETE ON ${qSchema}."_backenly_presence"
      FOR EACH ROW EXECUTE FUNCTION ${qSchema}.backenly_notify_presence()
  `)

  bootstrappedProjects.add(projectId)
}

router.get('/:projectId/presence', v1AuthMiddleware, async (req: Request, res: Response) => {
  const { projectId } = req.params
  try {
    const qSchema = quoteIdent(workspaceSchemaName(projectId))
    await ensurePresenceTable(projectId)
    const users = await prisma.$queryRawUnsafe<any[]>(
      `SELECT "userId", "metadata", "joinedAt", "lastSeen"
       FROM ${qSchema}."_backenly_presence"
       WHERE "lastSeen" > now() - interval '${PRESENCE_TTL_SECONDS} seconds'
       ORDER BY "joinedAt" ASC`
    )
    res.json({ users })
  } catch {
    res.status(500).json({ error: 'Presence lookup failed' })
  }
})

router.post('/:projectId/presence', v1AuthMiddleware, async (req: Request, res: Response) => {
  const { projectId } = req.params
  try {
    const qSchema = quoteIdent(workspaceSchemaName(projectId))
    const { userId, metadata = {} } = req.body

    if (!userId || typeof userId !== 'string') {
      res.status(400).json({ error: 'userId is required' })
      return
    }
    if (userId.length > 255) {
      res.status(400).json({ error: 'userId too long (max 255)' })
      return
    }

    await ensurePresenceTable(projectId)

    await prisma.$executeRawUnsafe(
      `INSERT INTO ${qSchema}."_backenly_presence" ("userId", "metadata", "lastSeen")
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT ("userId") DO UPDATE SET "lastSeen" = now(), "metadata" = EXCLUDED."metadata"`,
      userId, JSON.stringify(metadata)
    )

    await prisma.$executeRawUnsafe(
      `DELETE FROM ${qSchema}."_backenly_presence"
       WHERE "lastSeen" < now() - interval '${PRESENCE_TTL_SECONDS} seconds'`
    )

    res.json({ success: true })
  } catch {
    res.status(500).json({ error: 'Presence update failed' })
  }
})

router.delete('/:projectId/presence', v1AuthMiddleware, async (req: Request, res: Response) => {
  const { projectId } = req.params
  try {
    const qSchema = quoteIdent(workspaceSchemaName(projectId))
    let userId = (req.query.userId as string) || req.body?.userId || null

    if (!userId) {
      res.status(400).json({ error: 'userId is required' })
      return
    }

    await ensurePresenceTable(projectId)

    await prisma.$executeRawUnsafe(
      `DELETE FROM ${qSchema}."_backenly_presence" WHERE "userId" = $1`,
      userId
    )

    res.json({ success: true })
  } catch {
    res.status(500).json({ error: 'Presence delete failed' })
  }
})

export default router

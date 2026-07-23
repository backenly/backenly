/**
 * Presence API
 *
 * Tracks which users are currently online within a project.
 * Works by maintaining a `_backenly_presence` table in the workspace schema.
 * A specialized NOTIFY trigger fires presence events (type: "presence") onto
 * the same SSE channel — SDK subscribers receive them automatically.
 *
 * GET    /api/v1/:projectId/presence           — list online users
 * POST   /api/v1/:projectId/presence           — join / heartbeat
 * DELETE /api/v1/:projectId/presence           — leave (explicit)
 *
 * TTL: 60 s — clients must heartbeat every ≤25 s to stay "online".
 * Stale records are pruned on every POST heartbeat call.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { v1ApiMiddleware } from '@/lib/api/v1/middleware'

export const dynamic = 'force-dynamic'

const PRESENCE_TTL_SECONDS = 60

function schemaName(projectId: string) {
  return `workspace_${projectId}`
}

function channelName(projectId: string) {
  return `workspace_${projectId}_changes`
}

// ── DDL bootstrap ─────────────────────────────────────────────────────────────
// Module-level cache so we only run DDL once per warm function instance.
// DDL is idempotent (IF NOT EXISTS / CREATE OR REPLACE) so cold-start repeats
// are safe.
const bootstrappedProjects = new Set<string>()

async function ensurePresenceTable(projectId: string): Promise<void> {
  if (bootstrappedProjects.has(projectId)) return

  const schema = schemaName(projectId)
  const channel = channelName(projectId)

  // 1. Create table
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "${schema}"."_backenly_presence" (
      "userId"   TEXT        NOT NULL PRIMARY KEY,
      "metadata" JSONB       NOT NULL DEFAULT '{}',
      "joinedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "lastSeen" TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  // 2. Specialized NOTIFY function for presence events.
  //    Fires { type: "presence", event: "join"|"leave"|"update", userId, metadata }
  //    — NOT the generic insert/update/delete format.
  //    UPDATE events are suppressed when only lastSeen changed (heartbeat noise).
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION "${schema}".backenly_notify_presence()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        PERFORM pg_notify(
          '${channel}',
          json_build_object(
            'type',      'presence',
            'event',     'leave',
            'userId',    OLD."userId",
            'timestamp', extract(epoch from clock_timestamp())
          )::text
        );
        RETURN OLD;

      ELSIF TG_OP = 'INSERT' THEN
        PERFORM pg_notify(
          '${channel}',
          json_build_object(
            'type',      'presence',
            'event',     'join',
            'userId',    NEW."userId",
            'metadata',  NEW."metadata",
            'timestamp', extract(epoch from clock_timestamp())
          )::text
        );
        RETURN NEW;

      ELSE
        -- UPDATE: only fire if metadata actually changed, not just lastSeen heartbeat
        IF NEW."metadata"::text IS DISTINCT FROM OLD."metadata"::text THEN
          PERFORM pg_notify(
            '${channel}',
            json_build_object(
              'type',      'presence',
              'event',     'update',
              'userId',    NEW."userId",
              'metadata',  NEW."metadata",
              'timestamp', extract(epoch from clock_timestamp())
            )::text
          );
        END IF;
        RETURN NEW;
      END IF;
    END;
    $$
  `)

  // 3. Install trigger (drop first to handle function replacement)
  await prisma.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS backenly_presence_notify
    ON "${schema}"."_backenly_presence"
  `)

  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER backenly_presence_notify
      AFTER INSERT OR UPDATE OR DELETE
      ON "${schema}"."_backenly_presence"
      FOR EACH ROW
      EXECUTE FUNCTION "${schema}".backenly_notify_presence()
  `)

  bootstrappedProjects.add(projectId)
}

// ── Handlers ──────────────────────────────────────────────────────────────────

/** GET — list users online right now */
export async function GET(
  request: NextRequest,
  { params }: { params: { projectId: string } }
) {
  const auth = await v1ApiMiddleware(request, params)
  if (auth.response) return auth.response

  const { projectId } = params
  const schema = schemaName(projectId)

  try {
    await ensurePresenceTable(projectId)

    const users = await prisma.$queryRawUnsafe<
      Array<{ userId: string; metadata: any; joinedAt: Date; lastSeen: Date }>
    >(
      `SELECT "userId", "metadata", "joinedAt", "lastSeen"
       FROM   "${schema}"."_backenly_presence"
       WHERE  "lastSeen" > now() - interval '${PRESENCE_TTL_SECONDS} seconds'
       ORDER  BY "joinedAt" ASC`
    )

    return NextResponse.json({ users })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

/** POST — join or heartbeat (upsert lastSeen) */
export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string } }
) {
  const auth = await v1ApiMiddleware(request, params)
  if (auth.response) return auth.response

  const { projectId } = params
  const schema = schemaName(projectId)

  try {
    const body = await request.json()
    const { userId, metadata = {} } = body

    if (!userId || typeof userId !== 'string') {
      return NextResponse.json({ error: 'userId is required' }, { status: 400 })
    }
    if (userId.length > 255) {
      return NextResponse.json({ error: 'userId too long (max 255)' }, { status: 400 })
    }

    await ensurePresenceTable(projectId)

    // Upsert: insert on first join, update lastSeen (and metadata) on heartbeat
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${schema}"."_backenly_presence" ("userId", "metadata", "lastSeen")
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT ("userId") DO UPDATE
         SET "lastSeen" = now(),
             "metadata" = EXCLUDED."metadata"`,
      userId,
      JSON.stringify(metadata)
    )

    // Prune stale entries on every heartbeat (cheap — uses indexed lastSeen)
    await prisma.$executeRawUnsafe(
      `DELETE FROM "${schema}"."_backenly_presence"
       WHERE "lastSeen" < now() - interval '${PRESENCE_TTL_SECONDS} seconds'`
    )

    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

/** DELETE — explicit leave */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { projectId: string } }
) {
  const auth = await v1ApiMiddleware(request, params)
  if (auth.response) return auth.response

  const { projectId } = params
  const schema = schemaName(projectId)

  try {
    // Support both JSON body and query param (fetch keepalive can't always send body)
    let userId: string | null = request.nextUrl.searchParams.get('userId')
    if (!userId) {
      const body = await request.json().catch(() => ({}))
      userId = body.userId ?? null
    }

    if (!userId) {
      return NextResponse.json({ error: 'userId is required' }, { status: 400 })
    }

    await ensurePresenceTable(projectId)

    await prisma.$executeRawUnsafe(
      `DELETE FROM "${schema}"."_backenly_presence" WHERE "userId" = $1`,
      userId
    )

    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

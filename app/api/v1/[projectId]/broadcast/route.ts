/**
 * Broadcast API
 *
 * Sends an ephemeral event to all connected SSE clients for a project.
 * Nothing is written to the database — this is a pure pg_notify call.
 * Because NOTIFY (unlike LISTEN) works fine through connection pooling,
 * we use Prisma for simplicity.
 *
 * POST /api/v1/:projectId/broadcast
 * Body: { channel: string, payload?: object }
 *
 * All SSE subscribers receive:
 *   { type: "broadcast", channel: "typing", payload: {...}, timestamp: 1234567890 }
 *
 * SDK usage:
 *   backend.broadcast("typing", { userId: "u1", room: "general" })
 *   backend.onBroadcast("typing", (payload) => showTyping(payload.userId))
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { v1ApiMiddleware } from '@/lib/api/v1/middleware'

export const dynamic = 'force-dynamic'

// Max payload size to stay safely within pg_notify's 8 000-byte limit
const MAX_PAYLOAD_BYTES = 6_000

// Channel names: alphanumeric, hyphens, underscores — no SQL injection surface
const CHANNEL_RE = /^[a-zA-Z0-9_-]{1,64}$/

export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string } }
) {
  const auth = await v1ApiMiddleware(request, params)
  if (auth.response) return auth.response

  const { projectId } = params

  try {
    const body = await request.json()
    const { channel, payload = {} } = body

    if (!channel || typeof channel !== 'string') {
      return NextResponse.json({ error: 'channel is required' }, { status: 400 })
    }
    if (!CHANNEL_RE.test(channel)) {
      return NextResponse.json(
        { error: 'channel must be 1–64 alphanumeric characters (hyphens and underscores allowed)' },
        { status: 400 }
      )
    }

    const notifyPayload = JSON.stringify({
      type: 'broadcast',
      channel,
      payload,
      timestamp: Date.now() / 1000,
    })

    if (Buffer.byteLength(notifyPayload, 'utf8') > MAX_PAYLOAD_BYTES) {
      return NextResponse.json(
        { error: 'payload too large (max ~6 KB)' },
        { status: 413 }
      )
    }

    const notifyChannel = `workspace_${projectId}_changes`

    // pg_notify works fine through PgBouncer — no persistent connection needed
    await prisma.$executeRawUnsafe(
      `SELECT pg_notify($1, $2)`,
      notifyChannel,
      notifyPayload
    )

    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

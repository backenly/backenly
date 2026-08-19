// app/api/v1/[projectId]/telemetry/route.ts
/**
 * POST /api/v1/{projectId}/telemetry
 *
 * PUBLIC runtime endpoint — consumed by the Backenly frontend SDK or any
 * client-side instrumentation layer to report API usage events for the
 * frontend-coevolution engine.
 *
 * Authentication: API key in `x-api-key` request header.
 * Validated against prisma.apiKey (isActive + correct projectId).
 *
 * Body: ApiUsageEvent  OR  ApiUsageEvent[]
 *
 * Hard limits:
 *   - Maximum 50 events per request (returns 400 if exceeded)
 *   - Each event is stored fire-and-forget via recordApiUsageEvent
 *
 * Response: { ok: true, recorded: N }
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { recordApiUsageEvent, type ApiUsageEvent } from '@/lib/ai/frontend-coevolution'

const MAX_EVENTS_PER_REQUEST = 50

export async function POST(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  const { projectId } = params

  // ── 1. Validate projectId ─────────────────────────────────────────────────

  if (!projectId || typeof projectId !== 'string') {
    return NextResponse.json(
      { error: 'Missing projectId', code: 'MISSING_PROJECT_ID' },
      { status: 400 },
    )
  }

  // ── 2. Authenticate via x-api-key ─────────────────────────────────────────

  const apiKeyHeader = request.headers.get('x-api-key')
  if (!apiKeyHeader) {
    return NextResponse.json(
      { error: 'Missing API key', code: 'MISSING_API_KEY' },
      { status: 401 },
    )
  }

  try {
    // Auth uses SHA-256 hash lookup (same as authenticateApiKey in lib/middleware/apiKeyAuth.ts)
    const keyHash = crypto.createHash('sha256').update(apiKeyHeader).digest('hex')

    const keyRecord = await prisma.apiKey.findFirst({
      where: {
        keyHash,
        projectId,
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: new Date() } },
        ],
      },
      select: { id: true },
    })

    if (!keyRecord) {
      return NextResponse.json(
        { error: 'Invalid or expired API key', code: 'INVALID_API_KEY' },
        { status: 401 },
      )
    }
  } catch (dbErr: any) {
    console.error('[telemetry] API key validation error:', dbErr?.message)
    return NextResponse.json(
      { error: 'Authentication check failed', code: 'AUTH_ERROR' },
      { status: 500 },
    )
  }

  // ── 3. Parse body ─────────────────────────────────────────────────────────

  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body', code: 'INVALID_BODY' },
      { status: 400 },
    )
  }

  const events: ApiUsageEvent[] = Array.isArray(rawBody) ? rawBody : [rawBody as ApiUsageEvent]

  // ── 4. Enforce per-request cap ────────────────────────────────────────────

  if (events.length > MAX_EVENTS_PER_REQUEST) {
    return NextResponse.json(
      {
        error: `Too many events. Maximum ${MAX_EVENTS_PER_REQUEST} per request.`,
        code: 'TOO_MANY_EVENTS',
        received: events.length,
        limit: MAX_EVENTS_PER_REQUEST,
      },
      { status: 400 },
    )
  }

  // ── 5. Validate and record each event ─────────────────────────────────────

  let recorded = 0
  const now = new Date().toISOString()

  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue

    const event: ApiUsageEvent = {
      endpoint:       String(raw.endpoint ?? ''),
      method:         String(raw.method ?? 'GET').toUpperCase(),
      tableName:      String(raw.tableName ?? ''),
      fieldsRead:     Array.isArray(raw.fieldsRead) ? raw.fieldsRead.map(String) : [],
      fieldsMissed:   Array.isArray(raw.fieldsMissed) ? raw.fieldsMissed.map(String) : [],
      responseStatus: typeof raw.responseStatus === 'number' ? raw.responseStatus : 200,
      timestamp:      typeof raw.timestamp === 'string' ? raw.timestamp : now,
    }

    // Skip events with no table name — they cannot be analysed
    if (!event.tableName) continue

    // Fire-and-forget — recordApiUsageEvent never throws
    recordApiUsageEvent(projectId, event).catch((err: any) => {
      console.warn('[telemetry] recordApiUsageEvent failed:', err?.message)
    })

    recorded += 1
  }

  // ── 6. Return success ─────────────────────────────────────────────────────

  return NextResponse.json({ ok: true, recorded }, { status: 200 })
}

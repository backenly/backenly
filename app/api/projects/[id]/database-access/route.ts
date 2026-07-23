/**
 * Direct database access — credential management.
 *
 *   GET    /api/projects/[id]/database-access          — status + connection strings
 *   POST   /api/projects/[id]/database-access          — provision { mode }
 *   DELETE /api/projects/[id]/database-access?mode=…   — revoke
 *
 * READ_ONLY: SELECT-only role — psql/TablePlus/BI/pg_dump, cannot mutate.
 * READ_WRITE: DML + in-schema DDL — external DDL is captured as drift and
 * adopted/flagged by the autonomy loop (lib/autonomy/drift-watch.ts).
 *
 * Secrets: responses include the decrypted password/connection string — this
 * is the owner-authenticated management surface, same trust boundary as the
 * env-var manager. Everything is audit-logged by the service.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import {
  getDirectAccessStatus,
  provisionDirectAccess,
  revokeDirectAccess,
  type DirectAccessMode,
} from '@/lib/services/direct-access'

function parseMode(v: unknown): DirectAccessMode | null {
  return v === 'READ_ONLY' || v === 'READ_WRITE' ? v : null
}

export async function GET(request: NextRequest) {
  return withProjectValidation<any>(request, async (validated) => {
    const status = await getDirectAccessStatus(validated.projectId)
    return NextResponse.json(status)
  })
}

export async function POST(request: NextRequest) {
  return withProjectValidation<any>(request, async (validated) => {
    const body = await request.json().catch(() => ({}))
    const mode = parseMode(body?.mode)
    if (!mode) {
      return NextResponse.json({ error: 'mode must be READ_ONLY or READ_WRITE' }, { status: 400 })
    }
    try {
      const credential = await provisionDirectAccess(validated.projectId, mode)
      return NextResponse.json({ credential })
    } catch (err: any) {
      console.error('[database-access] provision failed:', err?.message)
      // The definer functions only exist after scripts/setup-direct-access.sql
      // ran on the cluster — surface that honestly instead of a generic 500.
      const msg: string = err?.message ?? ''
      if (msg.includes('backenly_direct_create_role') && msg.includes('does not exist')) {
        return NextResponse.json(
          { error: 'Direct access is not enabled on this database cluster yet.' },
          { status: 503 },
        )
      }
      return NextResponse.json({ error: 'Could not provision database credentials.' }, { status: 500 })
    }
  })
}

export async function DELETE(request: NextRequest) {
  return withProjectValidation<any>(request, async (validated) => {
    const mode = parseMode(new URL(request.url).searchParams.get('mode'))
    if (!mode) {
      return NextResponse.json({ error: 'mode must be READ_ONLY or READ_WRITE' }, { status: 400 })
    }
    try {
      await revokeDirectAccess(validated.projectId, mode)
      return NextResponse.json({ revoked: true })
    } catch (err: any) {
      console.error('[database-access] revoke failed:', err?.message)
      return NextResponse.json({ error: 'Could not revoke database credentials.' }, { status: 500 })
    }
  })
}

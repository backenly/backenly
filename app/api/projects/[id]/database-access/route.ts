/**
 * Direct database access — credential management.
 *
 *   GET    /api/projects/[id]/database-access          — status + connection strings,
 *                                                         or why there are none (200,
 *                                                         available: false)
 *   POST   /api/projects/[id]/database-access          — provision { mode }
 *   PATCH  /api/projects/[id]/database-access          — { schemaChanges: "allowed" | "refused" }
 *   DELETE /api/projects/[id]/database-access?mode=…   — revoke
 *
 * READ_ONLY: SELECT-only role — psql/TablePlus/BI/pg_dump, cannot mutate.
 * READ_WRITE: DML. Schema changes over it are refused until the admin allows
 * them; allowed, they skip approvals and History and are captured as drift,
 * adopted or flagged by the autonomy loop (lib/autonomy/drift-watch.ts). They
 * can be allowed only on a project's own database reached through the
 * connection pooler, never on a database shared by several projects (409,
 * with why).
 *
 * Secrets: responses include passwords and connection strings — this is the
 * owner-authenticated management surface, same trust boundary as the env-var
 * manager. On a project's own database a read-write login's password is in
 * the POST (and rotate) answer only, once. Everything is audit-logged by the
 * service.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import {
  DirectAccessPausedError,
  DirectAccessUnavailableError,
  getDirectAccessStatus,
  provisionDirectAccess,
  revokeDirectAccess,
  setSchemaChanges,
  SCHEMA_CHANGES_UNAVAILABLE_MESSAGE,
  SchemaChangesUnavailableError,
  type DirectAccessMode,
} from '@/lib/services/direct-access'

/** Nothing outside Backenly can connect here: no login is issued or changed, and the answer says why. */
function unavailable(err: DirectAccessUnavailableError) {
  return NextResponse.json({ error: err.message, code: err.code, reason: err.reason }, { status: 503 })
}

function parseMode(v: unknown): DirectAccessMode | null {
  return v === 'READ_ONLY' || v === 'READ_WRITE' ? v : null
}

// ADMIN on every verb, GET included: the status response carries the decrypted
// password and connection string (see the header), so reading it GRANTS the
// credential. Classified by what it grants, not by the verb — the same rule
// that holds ai-functions/admin-key, a credential-returning GET, at ADMIN.
// Membership alone handed an organization VIEWER a live Postgres login.
export async function GET(request: NextRequest) {
  return withProjectValidation<any>(request, async (validated) => {
    return NextResponse.json(await getDirectAccessStatus(validated.projectId))
  }, { floor: 'administer' })
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
      if (err instanceof DirectAccessUnavailableError) return unavailable(err)
      // Paused or deleted: its logins are stopped, and the answer says to resume or restore it first.
      if (err instanceof DirectAccessPausedError) return NextResponse.json({ error: err.message, code: err.code }, { status: 409 })
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
  }, { floor: 'administer' })
}

// Whether the read-write login may change the schema. ADMIN, like creating
// the login: allowing it lets changes skip the approvals and History.
export async function PATCH(request: NextRequest) {
  return withProjectValidation<any>(request, async (validated) => {
    const body = await request.json().catch(() => ({}))
    const value = body?.schemaChanges
    if (value !== 'allowed' && value !== 'refused') {
      return NextResponse.json({ error: 'schemaChanges must be "allowed" or "refused"' }, { status: 400 })
    }
    try {
      const credential = await setSchemaChanges(validated.projectId, value === 'allowed')
      return NextResponse.json({ credential })
    } catch (err: any) {
      if (err instanceof DirectAccessUnavailableError) return unavailable(err)
      // Not allowed here, and the reason is the answer: a database shared by
      // several projects never allows them (scripts/setup-direct-access.sql,
      // section 5c), nor a project's own database where its region offers no
      // pooler; one whose helpers predate that cannot say.
      if (err instanceof SchemaChangesUnavailableError) {
        return NextResponse.json(
          { error: err.message, code: err.code, reason: err.reason },
          { status: err.reason === 'helpers_outdated' ? 503 : 409 },
        )
      }
      const msg: string = err?.message ?? ''
      if (msg.includes('no read-write login')) {
        return NextResponse.json({ error: 'This project has no read-write login.' }, { status: 404 })
      }
      console.error('[database-access] schema changes setting failed:', msg)
      // The definer arrives with scripts/setup-direct-access.sql; a database
      // that has not had it reinstalled cannot apply the setting.
      if (msg.includes('backenly_direct_set_schema_changes') && msg.includes('does not exist')) {
        return NextResponse.json(
          { error: SCHEMA_CHANGES_UNAVAILABLE_MESSAGE.helpers_outdated },
          { status: 503 },
        )
      }
      return NextResponse.json({ error: 'Could not change the setting.' }, { status: 500 })
    }
  }, { floor: 'administer' })
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
  }, { floor: 'administer' })
}

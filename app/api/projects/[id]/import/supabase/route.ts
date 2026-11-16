export const dynamic = 'force-dynamic'

/**
 * POST /api/projects/[id]/import/supabase — RETIRED (2026-11-16). Always 404.
 *
 * This was the July importer's door: switched off by SUPABASE_IMPORT_ENABLED
 * and, when on, it filled an EXISTING project from a Supabase connection
 * string. Moving a backend in is now its own flow, into a NEW project only,
 * from Supabase, Firebase or any Postgres: POST /api/import (lib/import/jobs.ts),
 * which an organization's owners and admins start and the console follows.
 *
 * The answer stays a flat 404 for everyone, before any auth, whatever the old
 * flag says, so a probe cannot tell a door was ever here. Kept rather than
 * deleted only because tests/integration/settings-keys-and-floors.spec.ts pins
 * that it stays shut.
 */

import { NextResponse } from 'next/server'

export async function POST() {
  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}

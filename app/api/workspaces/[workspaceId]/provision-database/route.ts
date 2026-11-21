export const dynamic = 'force-dynamic'

/**
 * POST /api/workspaces/[workspaceId]/provision-database — RETIRED (2026-11-21). Always 404.
 *
 * It provisioned a workspace's database on request: for a workspace already
 * provisioned it changed nothing, and for any other it created a separate
 * database with the platform's own connection and wrote that database's
 * connection string into Workspace.postgresSchema, where every reader expects
 * a schema name. No UI called it. A project's workspace schema is created with
 * the project, by createProvisionedProject (lib/projects/provision.ts), so
 * nothing is left for this route to do.
 *
 * The answer stays a flat 404 for everyone, before any auth, like the other
 * retired doors (app/api/projects/[id]/import/supabase/route.ts). Kept rather
 * than deleted only because tests/integration/workspace-routes-create-no-database.spec.ts
 * pins that it stays shut.
 */

import { NextResponse } from 'next/server'

export async function POST() {
  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}

/**
 * POST /api/projects/:id/activity — "a member opened this project's console".
 *
 * Sent once when the project shell mounts (components/shell/ProjectActivityBeacon),
 * never polled. It exists because the dashboard's own reads are deliberately
 * NOT counted as use (lib/middleware/projectValidation.ts): an open tab polling
 * health and usage must not keep an abandoned backend awake, but somebody
 * choosing to open the project is exactly the use the inactivity clock is for.
 *
 * The stamp is made by withProjectValidation, which counts every authorized
 * non-GET request, so this handler has nothing to do but answer. A paused
 * project is not stamped: the clock refuses to move while paused, and only
 * resuming restarts it.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  await props.params
  return withProjectValidation<null>(request, async () => new NextResponse(null, { status: 204 }))
}

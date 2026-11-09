/**
 * POST /api/projects/:id/realtime-ticket
 *
 * The ticket the console's Realtime page opens its stream with, issued to the
 * signed-in project member.
 *
 * The page used to open its stream with the project's anon key, so the stream
 * had no end user and no service role, and a stream delivers an insert or an
 * update only when it can read the row (lib/realtime/visibility.ts). On a table
 * whose rows only their owners may read, the page showed the deletes alone, as
 * bare ids, while the app's signed-in users received their own changes (#617).
 *
 * The console reads every row on the member's behalf
 * (tests/unit/dashboard-rls-blindness.spec.ts), so its stream reads every
 * change. The ticket is the one the v1 route mints (lib/realtime/sse-ticket.ts):
 * signed with the project's secret, so the stream in the project's region
 * verifies it from its own copy of the project, and good for one connection
 * within 30 seconds. This one reads as the service role and names the member
 * it was issued to. It is issued only when it can be spent once, and only by
 * POST, so no link, image or prefetch mints one.
 *
 * Who may have one: whoever may open the project, as for /realtime-status, which
 * the same page reads. They can already read every row in the console.
 */

import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth/middleware'
import { canAccessProject } from '@/lib/edition/guard'
import { prisma } from '@/lib/db/prisma'
import { JWTSecretManager, resolveJwtSecret } from '@/lib/services/jwtSecretManager'
import { mintSseTicket } from '@/lib/realtime/sse-ticket'
import { regionErrorResponse } from '@/lib/api/v1/errors'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** A credential must never be cached by an intermediary. */
const NO_STORE = { 'Cache-Control': 'no-store, no-cache, must-revalidate, private', Pragma: 'no-cache' }

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await props.params
  const auth = await authenticateRequest(request)
  if (!auth.authenticated || !auth.userId) {
    return NextResponse.json({ error: auth.error ?? 'Authentication required' }, { status: 401 })
  }
  if (!(await canAccessProject(auth.userId, projectId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  try {
    // The secret the project's stream verifies tickets with. A project that has
    // never had one gets it now, as on its first end-user sign-up (server/routes/auth.ts).
    // A stream in another region accepts it once the next delivery has copied it
    // there (lib/auth-projection/deliver.ts); the page retries until then.
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { jwtSecret: true } })
    const secret = project?.jwtSecret
      ? resolveJwtSecret(project.jwtSecret)
      : await JWTSecretManager.getOrCreateSecret(projectId)

    const minted = await mintSseTicket(secret, { projectId, operatorId: auth.userId, serviceRole: true })
    if (!minted.singleUse) {
      return NextResponse.json(
        {
          error:
            "The project's ticket ledger could not be reached, so no ticket was issued: one that reads every " +
            'change is issued only when it can be used once. Try again.',
          code: 'TICKET_LEDGER_UNAVAILABLE',
        },
        { status: 503, headers: NO_STORE },
      )
    }
    return NextResponse.json({ ticket: minted.ticket, expiresIn: minted.expiresIn }, { headers: NO_STORE })
  } catch (err) {
    const regional = regionErrorResponse(err)
    if (regional) return regional
    console.error('[realtime-ticket] %s', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

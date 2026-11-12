export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * POST /api/projects/:id/realtime-ticket
 *
 * A realtime ticket for the console's Realtime page: the project's own people
 * watching their project change. The page used to listen with the public anon
 * key, so a change reached it only if an anonymous visitor could read the row,
 * and on every table behind row-level security the owner saw nothing while the
 * page said "Listening for changes".
 *
 * The ticket sees every change, as the console's row browser shows every row to
 * the same people: any member of the project (withProjectValidation). It is signed with the project's own
 * secret, lasts 30 seconds and opens one connection (lib/realtime/sse-ticket.ts),
 * and the page asks for a new one on every connect, so no long-lived credential
 * sits in a URL. One that could be replayed is never issued: it would open
 * every change to whoever held it for those 30 seconds.
 *
 * POST only, like the public ticket route: a link, an image or a prefetch must
 * not mint one.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { authorizingProject } from '@/lib/auth-projection/read'
import { resolveJwtSecret } from '@/lib/services/jwtSecretManager'
import { mintSseTicket } from '@/lib/realtime/sse-ticket'

const NO_STORE = { 'Cache-Control': 'no-store, no-cache, must-revalidate, private', Pragma: 'no-cache' }

export async function POST(request: NextRequest) {
  return withProjectValidation<unknown>(request, async ({ projectId }) => {
    const project = await authorizingProject(projectId)
    if (!project?.jwtSecret) {
      return NextResponse.json(
        {
          error: 'This project has no signing secret yet, so it cannot issue a realtime ticket.',
          code: 'NO_PROJECT_SECRET',
        },
        { status: 409, headers: NO_STORE },
      )
    }

    const minted = await mintSseTicket(resolveJwtSecret(project.jwtSecret), {
      projectId,
      keyId: null,
      serviceRole: true,
    })
    if (!minted.singleUse) {
      return NextResponse.json(
        { error: 'A realtime ticket could not be issued just now. Try again in a moment.', code: 'TICKET_UNAVAILABLE' },
        { status: 503, headers: { ...NO_STORE, 'Retry-After': '5' } },
      )
    }
    return NextResponse.json({ ticket: minted.ticket, expiresIn: minted.expiresIn }, { headers: NO_STORE })
  })
}

export async function GET() {
  return NextResponse.json(
    { error: 'Use POST to get a realtime ticket.', code: 'METHOD_NOT_ALLOWED' },
    { status: 405, headers: { Allow: 'POST' } },
  )
}

/**
 * POST /api/v1/:projectId/realtime/ticket
 *
 * Exchange normal request headers for a short-lived, single-use realtime ticket.
 *
 * Why this exists: `EventSource` cannot send headers, so every browser SSE client
 * has to put its credential in the URL — and a URL is the worst place for a
 * long-lived one (nginx access logs, proxy logs, browser history, Referer). The
 * ticket is valid for 30 seconds and for one connection, so what ends up in the
 * logs is already spent. See lib/realtime/sse-ticket.ts.
 *
 * Auth: `Authorization: Bearer <apiKey>` (required) plus `X-User-Token: <jwt>`
 * (optional). Both travel as HEADERS here, which is the entire point — the
 * end-user's session token never touches a query string.
 */

import { NextRequest, NextResponse } from 'next/server'
import { v1ApiMiddleware } from '@/lib/api/v1/middleware'
import { prisma } from '@/lib/db/prisma'
import { resolveJwtSecret } from '@/lib/services/jwtSecretManager'
import { mintSseTicket, SSE_TICKET_TTL_SECONDS } from '@/lib/realtime/sse-ticket'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  const middleware = await v1ApiMiddleware(request, params)
  if (middleware.response) return middleware.response
  const { context } = middleware

  const project = await prisma.project.findUnique({
    where: { id: params.projectId },
    select: { jwtSecret: true },
  })

  // A project with no signing secret has never had auth enabled. Say that
  // instead of minting a ticket signed with a platform-wide key, which would be
  // a cross-project replay hole dressed up as a convenience.
  if (!project?.jwtSecret) {
    return NextResponse.json(
      {
        error:
          'This project has no JWT signing secret yet, so realtime tickets cannot be issued. ' +
          'Enable end-user auth first — the ticket is signed with the project secret so it can never ' +
          'be replayed against another project.',
        code: 'NO_PROJECT_SECRET',
      },
      { status: 409 },
    )
  }

  const minted = await mintSseTicket(resolveJwtSecret(project.jwtSecret), {
    projectId: params.projectId,
    keyId: context.apiKey.id,
    endUserId: context.endUserId,
    endUserRole: context.endUserRole,
    serviceRole: context.apiKey.serviceRole,
  })

  return NextResponse.json(
    {
      ticket: minted.ticket,
      expiresIn: minted.expiresIn,
      singleUse: minted.singleUse,
      // The end-user this ticket speaks for, echoed so a client can tell an
      // anonymous stream from an authenticated one without decoding the ticket.
      endUserId: context.endUserId,
      connect: `GET /api/v1/${params.projectId}/realtime?ticket=<ticket>`,
      // Stated, not implied. A property that quietly stopped holding would be
      // worse than one never claimed — see lib/realtime/sse-ticket.ts.
      ...(minted.singleUse
        ? {}
        : {
            warning:
              'Single-use could not be armed (the redemption ledger was unreachable). This ticket is ' +
              `still project-scoped and still expires in ${SSE_TICKET_TTL_SECONDS}s, but it is replayable ` +
              'inside that window.',
          }),
    },
    {
      status: 200,
      headers: {
        // A credential must never be cached by an intermediary.
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
        Pragma: 'no-cache',
      },
    },
  )
}

export async function GET() {
  return NextResponse.json(
    {
      error:
        'Use POST to mint a realtime ticket. GET is refused because a mint must not be triggerable by a ' +
        'link, an image tag, or a prefetch.',
      code: 'METHOD_NOT_ALLOWED',
    },
    { status: 405, headers: { Allow: 'POST' } },
  )
}

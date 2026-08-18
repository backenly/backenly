/**
 * Realtime SSE Endpoint (Next.js version — serves dev; prod routes /api/v1
 * to the Express runtime, which has the identical implementation).
 *
 * Streams live database change events to the client via Server-Sent Events.
 * Fan-out goes through the shared ListenerHub: ONE direct pg LISTEN
 * connection per process, any number of SSE subscribers. A subscriber costs
 * zero database connections.
 *
 * PLAN GATING: the hub enforces the owner's plan cap on concurrent
 * connections (Free 25 / Pro 1,000 / Enterprise custom). A blocked connect gets a
 * single `{ type: "error", code: "PLAN_LIMIT_EXCEEDED" }` frame and the
 * stream closes — SDK clients treat that code as fatal and stop retrying.
 *
 * Client usage (via SDK):
 *   backend.messages.subscribe((event) => console.log(event))
 *   const unsub = backend.messages.subscribe(callback)
 *   return () => unsub()
 *
 * URL:  GET /api/v1/:projectId/realtime?table=messages
 * URL:  GET /api/v1/:projectId/realtime          (all tables)
 */

import { NextRequest, NextResponse } from 'next/server'
import { v1ApiMiddleware } from '@/lib/api/v1/middleware'
import { listenerHub } from '@/lib/realtime/listener-hub'
import { redeemRealtimeTicketParam } from '@/lib/realtime/ticket-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  // ── Preferred: a short-lived single-use ticket ─────────────────────────────
  //
  // `EventSource` cannot send headers, so the credential has to be in the URL.
  // A ticket is the credential designed for that: 30 seconds, one connection,
  // signed with the project's own secret. `?apiKey=` still works for existing
  // clients — see the deprecation note below — but it puts a long-lived
  // credential into every access log it passes through.
  const ticket = request.nextUrl.searchParams.get('ticket')
  if (ticket) {
    const redeemed = await redeemRealtimeTicketParam(params.projectId, ticket)
    // `=== false` rather than `!redeemed.ok`: this project builds with
    // `strict: false`, so discriminated-union narrowing on a negated boolean
    // literal does not kick in. An explicit comparison narrows regardless.
    if (redeemed.ok === false) {
      return NextResponse.json({ error: redeemed.message, code: redeemed.code }, { status: 401 })
    }
  } else {
    // Authenticate via API key (supports ?apiKey= query param since EventSource
    // cannot send Authorization headers in the browser). DEPRECATED for browser
    // clients: prefer POST /realtime/ticket.
    const middleware = await v1ApiMiddleware(request, params)
    if (middleware.response) return middleware.response
  }

  const { projectId } = params
  const tableFilter = request.nextUrl.searchParams.get('table')
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      let subscription: { unsubscribe: () => void } | null = null
      let keepaliveTimer: ReturnType<typeof setInterval> | null = null
      let closed = false

      const send = (data: object) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch { /* controller already closed */ }
      }
      const sendComment = (comment: string) => {
        try {
          controller.enqueue(encoder.encode(`: ${comment}\n\n`))
        } catch { /* ignore */ }
      }

      const cleanup = () => {
        if (closed) return
        closed = true
        if (keepaliveTimer) clearInterval(keepaliveTimer)
        subscription?.unsubscribe()
        subscription = null
        try { controller.close() } catch { /* already closed */ }
      }

      try {
        const result = await listenerHub.subscribe(projectId, (payload) => {
          if (!tableFilter || payload.table === tableFilter) {
            send(payload)
          }
        })

        if (result.ok === false) {
          send({ type: 'error', code: result.code, message: result.message })
          cleanup()
          return
        }
        subscription = result

        send({ type: 'connected', projectId, channel: result.channel })

        // Keepalive comment every 25 s to prevent proxy/CDN idle timeouts.
        keepaliveTimer = setInterval(() => {
          if (!closed) sendComment('keepalive')
        }, 25_000)

        request.signal.addEventListener('abort', cleanup)
      } catch (err: any) {
        console.warn('[Realtime SSE] subscribe failed:', err?.message)
        send({ type: 'error', message: 'Failed to connect to realtime stream' })
        cleanup()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable Nginx/proxy buffering so events arrive immediately
      'X-Accel-Buffering': 'no',
    },
  })
}

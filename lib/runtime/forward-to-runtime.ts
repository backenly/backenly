/**
 * Hand a request Next does not serve to the runtime that does.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * On AWS (and in docker/compose.stack.yml) the load balancer sends every
 * request to Next, and the Express runtime sits behind it at RUNTIME_API_URL.
 * next.config.js tried to reach it with an `/api/v1/:path*` rewrite, but a
 * rewrite in that position only runs when no route matches, and
 * app/api/v1/[projectId]/[...unmatched] matches everything under a project. So
 * every runtime-only surface answered Next's JSON 404 in production:
 * `/db/{table}` (the REST path agents and generate_api advertise), `/fn/{name}`,
 * and the legacy table routes. `/api/v2` never got that far; the platform auth
 * middleware refused it with 401 before routing.
 *
 * The fix is the mirror of server/routes/next-proxy.ts, which forwards the
 * Next-owned sections from Express to Next on the single-box layout: whatever
 * Next does not own under a project goes to the runtime.
 *
 * ── What is and is not passed through ───────────────────────────────────────
 *
 * The request is forwarded as-is (method, path, query, headers, streamed body),
 * marked as internal so the runtime does not record it a second time (Next
 * already recorded it, lib/traffic/recorded-v1.ts). The response streams back
 * with the runtime's status and headers, minus its CORS headers: on this
 * ingress Next's middleware answers CORS, and two Access-Control-Allow-Origin
 * values are a CORS failure in every browser.
 */

import { internalTrafficHeaders } from '@/lib/traffic/request-recorder'

const REQUEST_DROP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
  'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
])

function keepResponseHeader(name: string): boolean {
  const n = name.toLowerCase()
  if (n.startsWith('access-control-')) return false
  // fetch has already decoded the body and knows its own framing.
  return !['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive'].includes(n)
}

/** The configured runtime origin, or null when this deployment has none. */
export function runtimeOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.RUNTIME_API_URL?.trim()
  return raw ? raw.replace(/\/+$/, '') : null
}

export async function forwardToRuntime(request: Request, origin: string): Promise<Response> {
  const incoming = new URL(request.url)
  const target = new URL(incoming.pathname + incoming.search, origin)

  const headers = new Headers()
  request.headers.forEach((value, key) => {
    if (!REQUEST_DROP.has(key.toLowerCase())) headers.set(key, value)
  })
  if (!headers.has('x-forwarded-host')) headers.set('x-forwarded-host', incoming.host)
  if (!headers.has('x-forwarded-proto')) headers.set('x-forwarded-proto', incoming.protocol.replace(':', ''))
  for (const [k, v] of Object.entries(internalTrafficHeaders())) headers.set(k, v)

  const method = request.method.toUpperCase()
  const hasBody = method !== 'GET' && method !== 'HEAD'

  let upstream: Response
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: 'manual',
      cache: 'no-store',
      // Required by Node's fetch to stream a request body.
      ...(hasBody ? { duplex: 'half' } : {}),
    } as RequestInit)
  } catch (err: any) {
    console.error(`[forwardToRuntime] ${method} ${incoming.pathname} → ${origin}: ${err?.message ?? err}`)
    return Response.json(
      {
        error: {
          code: 'RUNTIME_UNREACHABLE',
          message: 'The service that answers this route did not respond. Try again shortly.',
        },
      },
      { status: 502 },
    )
  }

  const out = new Headers()
  upstream.headers.forEach((value, key) => {
    if (keepResponseHeader(key) && key.toLowerCase() !== 'set-cookie') out.set(key, value)
  })
  for (const cookie of upstream.headers.getSetCookie?.() ?? []) out.append('set-cookie', cookie)

  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out })
}

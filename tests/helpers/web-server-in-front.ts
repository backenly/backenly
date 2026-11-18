/**
 * The web server in front of the runtime, as Next 16 serves a path under
 * /api/v1/{projectId} or /api/v2/{projectId} that it hands to the runtime.
 *
 * Built from Next's and Backenly's own code, in the order `next start` runs it
 * (server/lib/router-utils/resolve-routes.js, server/lib/router-server.js):
 *   1. next.config.js's header rules, matched with Next's own loader and
 *      matcher (tests/helpers/next-config-headers.ts);
 *   2. middleware.ts, whose headers replace the config's where both set one,
 *      and whose own answer (a CORS preflight, a refusal) is sent as it is;
 *   3. those headers set on the response before the route runs;
 *   4. the real route: app/api/v1/[projectId]/[...unmatched] or
 *      app/api/v2/[projectId]/[[...path]], both forwarding to the runtime at
 *      RUNTIME_API_URL (lib/runtime/forward-to-runtime.ts);
 *   5. Next's own server/send-response.js, which adds the route's headers
 *      where none is set yet and sends its body.
 *
 * A test that uses this mocks @sentry/nextjs (next.config.js pulls it in) and
 * imports tests/helpers/real-web-standard first.
 */

import http from 'http'
import { NextRequest } from 'next/server'

import { middleware } from '@/middleware'
import * as v1Forward from '@/app/api/v1/[projectId]/[...unmatched]/route'
import * as v2Forward from '@/app/api/v2/[projectId]/[[...path]]/route'
import { configHeadersFor, nextConfigHeaderRules } from '@/tests/helpers/next-config-headers'

const { sendResponse } = require('next/dist/server/send-response') as {
  sendResponse: (req: http.IncomingMessage, res: unknown, response: Response) => Promise<void>
}
const { NodeNextResponse } = require('next/dist/server/base-http/node') as { NodeNextResponse: new (res: http.ServerResponse) => unknown }

type Route = (request: NextRequest, context: { params: Promise<Record<string, unknown>> }) => Promise<Response>

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

export async function webServerInFront(): Promise<http.Server> {
  const rules = await nextConfigHeaderRules()
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    const method = req.method ?? 'GET'
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value)
    const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req)
    const request = new NextRequest(url, { method, headers, body })

    const resHeaders = configHeadersFor(rules, url.pathname)
    const fromMiddleware = await middleware(request)
    const answeredByMiddleware =
      !!fromMiddleware && fromMiddleware.headers.get('x-middleware-next') === null && fromMiddleware.headers.get('x-middleware-rewrite') === null
    fromMiddleware?.headers.forEach((value, name) => {
      if (!name.startsWith('x-middleware-') && name !== 'content-length') resHeaders[name.toLowerCase()] = value
    })
    for (const [name, value] of Object.entries(resHeaders)) res.setHeader(name, value)
    if (answeredByMiddleware) {
      res.statusCode = fromMiddleware!.status
      res.end(Buffer.from(await fromMiddleware!.arrayBuffer()))
      return
    }

    const [, , version, projectId, ...rest] = url.pathname.split('/')
    const route = (version === 'v2' ? v2Forward : v1Forward) as unknown as Record<string, Route>
    const params = version === 'v2' ? { projectId, path: rest } : { projectId, unmatched: rest }
    const response = await route[method](request, { params: Promise.resolve(params) })
    await sendResponse(req, new NodeNextResponse(res), response)
  })
}

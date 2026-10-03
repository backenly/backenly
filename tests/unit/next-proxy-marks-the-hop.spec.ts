/**
 * THE RUNTIME MARKS WHAT IT HANDS TO NEXT AS A HOP, NOT JUST AS INTERNAL
 * ======================================================================
 *
 * Next's catch-all (app/api/v1/[projectId]/[...unmatched]) forwards whatever it
 * does not serve to the runtime, and refuses only a request that already came
 * FROM the runtime, so a path neither side serves cannot bounce between them.
 * The signal it reads is RUNTIME_HOP_HEADER, and this is the only place that
 * sets it: server/routes/next-proxy.ts, on its way to Next.
 *
 * It used to read the internal-traffic header instead, which the contract probe
 * also sends. Every probe of /db and /fn was then refused with Next's own 404
 * and filed as the tenant's broken surface (AWS staging, v8 qualification). So
 * this proves, through the real middleware and a real socket, that the runtime
 * sends BOTH markers: internal (it already recorded the request) and hop (it
 * came from the runtime). If the hop marker is ever dropped here, the loop
 * guard loses its signal and a path neither side serves loops.
 */

import http from 'http'
import type { AddressInfo } from 'net'
import express from 'express'

import { nextProxy } from '@/server/routes/next-proxy'
import { RUNTIME_HOP_HEADER } from '@/lib/runtime/forward-to-runtime'
import { INTERNAL_TRAFFIC_HEADER, internalTrafficHeaders } from '@/lib/traffic/request-recorder'

const PROJECT = '7e89af77-8bb1-4655-84e8-3d1c15b334b4'

let next: http.Server
let runtime: http.Server
let runtimeOrigin = ''
let seen: http.IncomingHttpHeaders[] = []
const savedOrigin = process.env.NEXT_INTERNAL_ORIGIN

beforeAll(async () => {
  next = http.createServer((req, res) => {
    seen.push(req.headers)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"from":"next"}')
  })
  await new Promise<void>(r => next.listen(0, '127.0.0.1', r))
  process.env.NEXT_INTERNAL_ORIGIN = `http://127.0.0.1:${(next.address() as AddressInfo).port}`

  const app = express()
  app.use('/api/v1', nextProxy)
  runtime = http.createServer(app)
  await new Promise<void>(r => runtime.listen(0, '127.0.0.1', r))
  runtimeOrigin = `http://127.0.0.1:${(runtime.address() as AddressInfo).port}`
})

afterAll(async () => {
  if (savedOrigin === undefined) delete process.env.NEXT_INTERNAL_ORIGIN
  else process.env.NEXT_INTERNAL_ORIGIN = savedOrigin
  await new Promise<void>(r => runtime.close(() => r()))
  await new Promise<void>(r => next.close(() => r()))
})

beforeEach(() => { seen = [] })

describe('server/routes/next-proxy.ts', () => {
  it('hands a Next-owned path to Next marked as a hop AND as internal', async () => {
    const res = await fetch(`${runtimeOrigin}/api/v1/${PROJECT}/storage/files`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ from: 'next' })
    expect(seen).toHaveLength(1)
    expect(seen[0][RUNTIME_HOP_HEADER]).toBe('runtime')
    expect(seen[0][INTERNAL_TRAFFIC_HEADER]).toBe(internalTrafficHeaders()[INTERNAL_TRAFFIC_HEADER])
  })

  it('does not proxy what the runtime serves itself', async () => {
    // /db is the runtime's own. The middleware passes it on (404 here, since
    // this bare app mounts nothing else), and Next never sees it.
    const res = await fetch(`${runtimeOrigin}/api/v1/${PROJECT}/db/todos`)
    expect(res.status).toBe(404)
    expect(seen).toHaveLength(0)
  })
})

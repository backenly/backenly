/**
 * POST /api/connect/url inspects an app at an address its caller names
 * (lib/services/app-inspector.ts). It fetched that address with a bare
 * `fetch`, so the server opened whatever it was given: the loopback
 * interface, the network it runs in, the cloud metadata address. It now goes
 * through the outbound guard (lib/security/outbound-guard.ts), which opens a
 * public address only and checks again at each redirect and at connect time.
 *
 * A local HTTP server stands in for an internal service. Its page title is a
 * marker, and the inspector reports a page's title as the app's name, so the
 * marker anywhere in a result means the inside page came back.
 */

import http from 'http'
import type { AddressInfo } from 'net'
import { AppInspector } from '@/lib/services/app-inspector'

const MARKER = `internal-page-${Date.now()}`
const HATCH = 'BACKENLY_WEBHOOK_EGRESS_ALLOW_PRIVATE'
const ORIGINAL_HATCH = process.env[HATCH]

let server: http.Server
let port = 0

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<html><head><title>${MARKER}</title></head><body><script>fetch('/api/items')</script></body></html>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  delete process.env[HATCH]
})

afterEach(() => {
  if (ORIGINAL_HATCH === undefined) delete process.env[HATCH]
  else process.env[HATCH] = ORIGINAL_HATCH
})

it.each([
  ['the loopback address', () => `http://127.0.0.1:${port}/`],
  ['localhost', () => `http://localhost:${port}/`],
])('does not open %s', async (_what, url) => {
  const result = await AppInspector.inspect(url())

  expect(result.success).toBe(false)
  expect(result.error).toMatch(/^Couldn't inspect that app: /)
  expect(JSON.stringify(result)).not.toContain(MARKER)
}, 15_000)

it('refuses the cloud metadata address before connecting to it', async () => {
  const started = Date.now()

  const result = await AppInspector.inspect('http://169.254.169.254/latest/meta-data/')

  expect(result.success).toBe(false)
  expect(result.error).toMatch(/^Couldn't inspect that app: /)
  expect(Date.now() - started).toBeLessThan(2_000)
}, 15_000)

it('still inspects an app it may open: a self-hosted install that allows its own network', async () => {
  process.env[HATCH] = 'true'

  const result = await AppInspector.inspect(`http://127.0.0.1:${port}/`)

  expect(result.success).toBe(true)
  expect(result.data?.appName).toBe(MARKER)
  expect(result.data?.detectedAPIs.map((api) => api.endpoint)).toContain('/api/items')
}, 15_000)

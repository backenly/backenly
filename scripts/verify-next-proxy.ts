/**
 * Behavioral verifier for server/routes/next-proxy.ts.
 *
 * Boots a stub "Next" upstream + a minimal Express app with the real proxy
 * middleware, then asserts each v1 path either forwards to Next or falls
 * through to the Express runtime — mirroring the prod nginx→Express topology.
 * No database or real Next server required.
 *
 * Run: npx tsx scripts/verify-next-proxy.ts
 */
import http from 'http'
import express from 'express'
import { nextProxy } from '../server/routes/next-proxy'

const UUID = '0e05907b-dab8-4278-87f1-ba792eb01b36'
const received: string[] = []

const stub = http.createServer((req, res) => {
  received.push(`${req.method} ${req.url}`)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, path: req.url }))
})

async function main() {
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r))
  const stubPort = (stub.address() as any).port
  process.env.NEXT_INTERNAL_ORIGIN = `http://127.0.0.1:${stubPort}`

  // Mirrors server/app.ts mount order: proxy first, everything else after.
  const app = express()
  app.use('/api/v1', nextProxy)
  app.use('/api/v1', (_req, res) => res.status(299).json({ fellThrough: true }))

  const srv = http.createServer(app)
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as any).port
  const base = `http://127.0.0.1:${port}/api/v1`

  const cases: Array<[string, string, 'proxied' | 'fallthrough']> = [
    // Next-owned surfaces → must forward
    ['POST', `/${UUID}/webhooks/stripe`, 'proxied'],
    ['GET', `/${UUID}`, 'proxied'],
    ['GET', `/${UUID}/storage/files`, 'proxied'],
    ['POST', `/${UUID}/db/posts/vector-search`, 'proxied'],
    ['POST', `/${UUID}/checkout`, 'proxied'],
    // Express-native surfaces → must fall through untouched
    ['POST', `/${UUID}/database/query`, 'fallthrough'],
    ['POST', `/${UUID}/auth/signin`, 'fallthrough'],
    ['GET', `/${UUID}/realtime`, 'fallthrough'],
    // Table CRUD (resource-shaped, no UUID prefix) → never proxied
    ['GET', `/not-a-uuid/webhooks/stripe`, 'fallthrough'],
    ['GET', `/posts`, 'fallthrough'],
  ]

  let failures = 0
  for (const [method, path, expect] of cases) {
    const res = await fetch(base + path, {
      method,
      body: method === 'POST' ? '{"raw":"body"}' : undefined,
      headers: { 'content-type': 'application/json' },
    })
    const got = res.status === 200 ? 'proxied' : res.status === 299 ? 'fallthrough' : `HTTP ${res.status}`
    const pass = got === expect
    if (!pass) failures++
    console.log(`${pass ? '✔' : '✖'} ${method} ${path} → ${got} (expected ${expect})`)
  }

  const echo = received.find((r) => r.includes('/webhooks/stripe'))
  console.log(echo ? `✔ upstream received webhook: ${echo}` : '✖ upstream never received the webhook')
  if (!echo) failures++

  // Close cleanly and set exitCode instead of process.exit() — hard-exiting
  // while sockets are mid-teardown trips a libuv assertion on Windows.
  await new Promise((r) => srv.close(r))
  await new Promise((r) => stub.close(r))
  if (failures > 0) {
    console.error(`\n✖ ${failures} proxy routing case(s) failed`)
    process.exitCode = 1
    return
  }
  console.log('\n✔ next-proxy routing verified')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

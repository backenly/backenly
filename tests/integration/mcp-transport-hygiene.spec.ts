/**
 * MCP TRANSPORT HYGIENE: REGISTRATION IS CAPPED, POSTS ARE NEVER REPLAYED,
 * AND `init` PRINTS WIRING STEPS THAT WORK
 * ========================================================================
 * Three findings in the transport layer:
 *
 *   - T8: dynamic client registration promised "capped per source" in its own
 *     header and had no cap at all — a loop could mint unbounded client_ids,
 *     each a valid consent-screen starter for phishing links.
 *   - T7: the stdio package re-sent POST bodies on 502/503/504. A 504 is the
 *     gateway giving up on a request the server is still executing (the brain
 *     runs up to 90 s), so one long backend_chat became three runs with
 *     duplicate tables and triggers.
 *   - T6: `npx @backenly/mcp-server init` told Claude Code users to edit
 *     ~/.claude/mcp.json (a file Claude Code never reads) and printed no Codex
 *     step although it promised one.
 *
 * The register route runs real against the database; the retry pin drives the
 * real client against a local HTTP server counting hits.
 */

import '@/tests/helpers/real-web-standard'
import http from 'http'
import fs from 'fs'
import path from 'path'
import type { AddressInfo } from 'net'
import { randomUUID } from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { POST as registerPOST } from '@/app/api/mcp/oauth/register/route'
import { BackenlyClient, BackenlyHttpError } from '../../packages/mcp-server/src/http'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

beforeAll(() => assertSafeTestDatabase())

const madeClientNames: string[] = []
afterAll(async () => {
  if (madeClientNames.length > 0) {
    await prisma.mcpOAuthClient.deleteMany({ where: { clientName: { in: madeClientNames } } }).catch(() => {})
  }
})

function registerReq(body: unknown, ip: string) {
  return new NextRequest('https://backenly.test/api/mcp/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  })
}

describe('T8: registration is capped per source and idempotent per client', () => {
  it('the sixth registration in a minute from one address is refused', async () => {
    const name = `cap-probe-${randomUUID().slice(0, 8)}`
    madeClientNames.push(name)
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      const res = await registerPOST(registerReq({ client_name: name, redirect_uris: ['https://x.example/cb'] }, ip))
      statuses.push(res.status)
    }
    expect(statuses.slice(0, 5).every((s) => s === 201)).toBe(true)
    expect(statuses[5]).toBe(429)
  }, 60_000)

  it('the same name + redirect set answers the SAME client_id and stores one row', async () => {
    const name = `dedupe-probe-${randomUUID().slice(0, 8)}`
    madeClientNames.push(name)
    const ids = new Set<string>()
    for (let i = 0; i < 3; i++) {
      // Distinct addresses so the cap never masks the dedupe under test.
      const res = await registerPOST(
        registerReq({ client_name: name, redirect_uris: ['https://y.example/cb', 'https://a.example/cb'] }, `198.51.100.${10 + i}`),
      )
      expect(res.status).toBe(201)
      ids.add((await res.json()).client_id)
    }
    expect(ids.size).toBe(1)
    const rows = await prisma.mcpOAuthClient.findMany({ where: { clientName: name } })
    expect(rows).toHaveLength(1)
  }, 60_000)
})

describe('T7: the stdio client never replays a POST', () => {
  let server: http.Server
  let endpoint = ''
  let postHits = 0
  let getHits = 0

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        postHits++
        res.statusCode = 504
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: 'gateway timeout' }))
        return
      }
      getHits++
      if (getHits < 3) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: 'flaky' }))
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('a 504 on POST surfaces once — the body is not re-sent', async () => {
    postHits = 0
    const client = new BackenlyClient({ apiKey: 'mcp_live_test', endpoint } as any)
    const err = await (client as any).request('POST', '/api/mcp/tool', { tool: 'backend_chat' }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(BackenlyHttpError)
    expect((err as any).status).toBe(504)
    expect(postHits).toBe(1)
  }, 60_000)

  it('GET still retries through transient 5xx', async () => {
    getHits = 0
    const client = new BackenlyClient({ apiKey: 'mcp_live_test', endpoint } as any)
    const out = await (client as any).request('GET', '/api/mcp/manifest')
    expect(out).toEqual({ ok: true })
    expect(getHits).toBe(3)
  }, 60_000)
})

describe('T6: init prints wiring that the hosts actually read', () => {
  const initSrc = fs.readFileSync(path.join(process.cwd(), 'packages', 'mcp-server', 'src', 'init.ts'), 'utf8')

  it('Claude Code gets the claude mcp add command, not a file Claude Code never reads', () => {
    expect(initSrc).toContain('claude mcp add backenly')
    expect(initSrc).not.toContain(".claude', 'mcp.json'")
  })

  it('Codex gets a step, as the banner promises', () => {
    expect(initSrc).toContain('codex mcp add backenly')
    expect(initSrc).toContain('[mcp_servers.backenly]')
  })
})

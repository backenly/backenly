/**
 * read_backend_state { section: "webhooks" } ANSWERS THE WEBHOOKS PAGE
 * ====================================================================
 * The section used to route to list_webhook_deliveries — the AppTrigger
 * delivery log, which only fills for writes through the legacy /database/*
 * routes — so an agent grounding itself on a project with live webhook
 * endpoints was told "No webhook deliveries yet on this project" and reported
 * that no webhooks were configured (or re-created the ones that exist).
 *
 * The section now answers the configured endpoints (list_webhooks), and the
 * delivery log stays reachable as its own `deliveries` section. Real MCP tool
 * route, real key, real database.
 */

import '@/tests/helpers/real-web-standard'
import crypto, { randomUUID } from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { POST } from '@/app/api/mcp/tool/route'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

let ownerId = ''
let projectId = ''
let mcpKey = ''

async function call(tool: string, args: Record<string, unknown> = {}) {
  const res = await POST(
    new NextRequest('https://backenly.test/api/mcp/tool', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': mcpKey },
      body: JSON.stringify({ tool, args }),
    }),
  )
  return { status: res.status, body: (await res.json()) as any }
}

beforeAll(async () => {
  assertSafeTestDatabase()
  ownerId = (
    await prisma.user.create({
      data: { email: `state-wh-${randomUUID()}@test.invalid`, name: 'State Webhooks Test' },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: `state-wh-${randomUUID().slice(0, 8)}`, userId: ownerId },
      select: { id: true },
    })
  ).id

  mcpKey = `mcp_live_${crypto.randomBytes(20).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'MCP key',
      keyPrefix: mcpKey.slice(0, 16),
      keyHash: crypto.createHash('sha256').update(mcpKey).digest('hex'),
      permissions: ['read', 'write'],
      capabilities: [],
      userId: ownerId,
      projectId,
      keyType: 'mcp',
      scope: 'mcp',
      serviceRole: false,
      rateLimit: 1000,
    },
  })

  await prisma.webhook.create({
    data: {
      projectId,
      targetUrl: 'https://hooks.acme.example/orders',
      eventType: 'row.inserted',
      active: true,
      secret: `whsec_${crypto.randomBytes(16).toString('hex')}`,
    },
  })
}, 120_000)

afterAll(async () => {
  await prisma.webhook.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
})

it('the webhooks section lists the configured endpoint, not an empty delivery log', async () => {
  const res = await call('read_backend_state', { section: 'webhooks' })
  expect(res.status).toBe(200)
  expect(res.body.ok).toBe(true)
  const text = JSON.stringify(res.body)
  expect(text).toContain('hooks.acme.example')
  expect(text).not.toContain('No webhook deliveries yet')
  // The signing secret never rides along on a read.
  expect(text).not.toContain('whsec_')
}, 60_000)

it('the delivery log is still reachable, as its own section', async () => {
  const res = await call('read_backend_state', { section: 'deliveries' })
  expect(res.status).toBe(200)
  expect(res.body.ok).toBe(true)
}, 60_000)

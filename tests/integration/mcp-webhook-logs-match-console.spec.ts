/**
 * AN AGENT READS A WEBHOOK'S DELIVERIES AS THE CONSOLE DOES
 * =========================================================
 * The Webhooks page lists one endpoint's deliveries with their status, HTTP
 * code, attempts, error and the receiver's answer, and leaves out the request
 * payload, which is the project's row data
 * (app/api/projects/[id]/webhooks/[webhookId]/logs). `webhooks { action:
 * "logs" }` serves the same list to an agent, and a read-only key may call it,
 * so it answers with the same fields.
 *
 * Real database, the real MCP tool route with a read-only key, and the real
 * console route with the owner as the caller.
 */

import '../helpers/next-request-polyfill'
import crypto from 'crypto'

let currentUserId = ''

// withAuth reads the session through next/headers, which jest cannot drive.
jest.mock('@/lib/auth/server', () => {
  const actual = jest.requireActual('@/lib/auth/server')
  return {
    ...actual,
    requireUser: jest.fn(async () => ({ userId: currentUserId, email: `${currentUserId}@test.invalid`, role: 'user' })),
  }
})

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/lib/auth/apiKeyAuth'
import { resetSingleTenantCache } from '@/lib/edition/single-tenant/project-resolver'
import { POST as mcpTool } from '@/app/api/mcp/tool/route'
import { GET as consoleLogs } from '@/app/api/projects/[id]/webhooks/[webhookId]/logs/route'

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION

let ownerId = ''
let projectId = ''
let webhookId = ''
let readOnlyKey = ''

// The row values a delivery carried, made unique per run so a match can only
// come from this suite's own rows.
const run = crypto.randomBytes(6).toString('hex')
const ROW = { id: 7, email: `ada-${run}@example.test`, reset_token: `rt-new-${run}` }
const OLD_ROW = { id: 7, email: `old-${run}@example.test`, reset_token: `rt-old-${run}` }

async function callTool(key: string, tool: string, args: Record<string, unknown>) {
  const res = await mcpTool(new NextRequest('https://backenly.test/api/mcp/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ tool, args }),
  }))
  return { status: res.status, body: (await res.json()) as any }
}

async function readConsole() {
  currentUserId = ownerId
  const path = `/api/projects/${projectId}/webhooks/${webhookId}/logs`
  const res = await consoleLogs(
    new NextRequest(`https://backenly.test${path}`, { method: 'GET' }),
    { params: Promise.resolve({ id: projectId, webhookId }) },
  )
  return { status: res.status, body: (await res.json()) as any }
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  resetSingleTenantCache()
  ownerId = (await prisma.user.create({
    data: { email: `whlogs-${run}@example.test`, password: 'not-a-real-hash', name: 'Webhook logs' },
    select: { id: true },
  })).id
  projectId = (await prisma.project.create({ data: { name: `whlogs-${run}`, userId: ownerId }, select: { id: true } })).id
  webhookId = (await prisma.webhook.create({
    data: { projectId, eventType: 'row.updated', targetUrl: 'https://receiver.example.test/hook', secret: `whsec-${run}` },
    select: { id: true },
  })).id
  const payload = {
    event: 'row.updated',
    timestamp: new Date().toISOString(),
    projectId,
    data: { table: 'customers', record: ROW, old: OLD_ROW, truncated: false, outboxId: '1' },
  }
  await prisma.webhookLog.create({
    data: {
      webhookId,
      eventType: 'row.updated',
      payload,
      signature: 'sha256=test',
      status: 'FAILED',
      statusCode: 422,
      responseBody: 'missing field: plan',
      error: 'HTTP 422',
      attemptCount: 1,
    },
  })
  readOnlyKey = `mcp_live_${crypto.randomBytes(20).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'agent (read-only)', keyPrefix: readOnlyKey.slice(0, 12), keyHash: hashApiKey(readOnlyKey),
      userId: ownerId, projectId, scope: 'mcp', mcpReadOnly: true, permissions: [], capabilities: [],
    },
  })
}, 120_000)

afterAll(async () => {
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  resetSingleTenantCache()
  await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.webhook.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 120_000)

describe('webhooks { action: "logs" } over MCP', () => {
  it('lists the delivery with its status, code, error and the receiver\'s answer', async () => {
    const { status, body } = await callTool(readOnlyKey, 'webhooks', { action: 'logs', webhookId })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    const [delivery] = body.data.deliveries
    expect(delivery).toMatchObject({
      status: 'FAILED',
      eventType: 'row.updated',
      statusCode: 422,
      attemptCount: 1,
      error: 'HTTP 422',
      responseBody: 'missing field: plan',
    })
  }, 60_000)

  it('returns none of the row data the delivery carried', async () => {
    const { body } = await callTool(readOnlyKey, 'webhooks', { action: 'logs', webhookId })
    expect(body.data.deliveries[0]).not.toHaveProperty('payload')
    const text = JSON.stringify(body)
    for (const value of [ROW.email, ROW.reset_token, OLD_ROW.email, OLD_ROW.reset_token]) {
      expect(text).not.toContain(value)
    }
  }, 60_000)

  it('has exactly the fields the console\'s delivery list has', async () => {
    const agent = await callTool(readOnlyKey, 'webhooks', { action: 'logs', webhookId })
    const page = await readConsole()
    expect(page.status).toBe(200)
    expect(Object.keys(agent.body.data.deliveries[0]).sort()).toEqual(Object.keys(page.body.logs[0]).sort())
  }, 60_000)
})

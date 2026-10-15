/**
 * TRIGGER WEBHOOKS GO THROUGH THE EGRESS GUARD, AND CAPTURE FOLLOWS NEW TABLES
 * ============================================================================
 * Two delivery-integrity holes in the trigger/webhook machinery:
 *
 * 1. Trigger webhooks fired a RAW `fetch` on the stored URL from the web
 *    process and persisted the failure text — a server-side request forgery
 *    primitive with a persistence layer (loopback services, the VPC,
 *    169.254.169.254), readable back through `webhooks {trigger_deliveries}`.
 *    Endpoint webhooks had already been moved to `safeFetch` for exactly this
 *    reason; triggers were left behind.
 *
 * 2. `syncWebhookCapture` promises to run "after a table is added", but no
 *    creation path called it — a row webhook saved on Monday never saw rows in
 *    a table created on Tuesday, while the page promised capture "for every
 *    writer".
 *
 * Pinned here:
 *   - creating a trigger aimed at a blocked destination is refused with the
 *     guard's reason (metadata service, loopback)
 *   - delivery goes through safeFetch with the webhook egress scope, and the
 *     raw global fetch is never touched (the guard is delegated to, not faked:
 *     only the OUTBOUND HTTP call is stubbed)
 *   - a stored failure body is capped
 *   - CREATE_TABLE through the real executor calls the capture sync
 */

import { randomUUID } from 'crypto'

/** Delegating record over the egress guard; only the network call is stubbed. */
const guardCalls: Array<{ url: string; opts: any }> = []
let nextResponse: { ok: boolean; status: number; text: string } = { ok: true, status: 200, text: '' }
jest.mock('@/lib/security/outbound-guard', () => {
  const actual = jest.requireActual('@/lib/security/outbound-guard')
  return {
    ...actual,
    safeFetch: async (url: string, opts: any) => {
      // The real validator runs — a blocked URL throws exactly as production.
      actual.assertAllowedUrl(url, opts?.egressScope ?? 'function')
      guardCalls.push({ url, opts })
      const r = nextResponse
      return { ok: r.ok, status: r.status, text: async () => r.text }
    },
  }
})

/** The capture sync, delegated with a call record. */
const captureCalls: string[] = []
jest.mock('@/lib/webhooks/capture', () => {
  const actual = jest.requireActual('@/lib/webhooks/capture')
  return {
    ...actual,
    syncWebhookCapture: async (projectId: string) => {
      captureCalls.push(projectId)
      return { events: [], tables: [] }
    },
  }
})

import { prisma } from '@/lib/db/prisma'
import { createTrigger, fireTriggers } from '@/lib/services/trigger-service'
import { executeAction } from '@/lib/ai/minimal-executor'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

const createdUserIds: string[] = []
const createdProjectIds: string[] = []
let projectId = ''

beforeAll(async () => {
  assertSafeTestDatabase()
  const u = await prisma.user.create({
    data: { email: `twe-${randomUUID()}@test.invalid`, name: 'Trigger Egress Test' },
    select: { id: true },
  })
  createdUserIds.push(u.id)
  const p = await prisma.project.create({
    data: { name: `twe-${randomUUID().slice(0, 8)}`, userId: u.id },
    select: { id: true },
  })
  createdProjectIds.push(p.id)
  projectId = p.id
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${projectId}"`)
})

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
  if (createdProjectIds.length) {
    await prisma.triggerDeliveryLog.deleteMany({ where: { trigger: { projectId: { in: createdProjectIds } } } }).catch(() => {})
    await prisma.appTrigger.deleteMany({ where: { projectId: { in: createdProjectIds } } })
    await prisma.backendEvent.deleteMany({ where: { projectId: { in: createdProjectIds } } }).catch(() => {})
    await prisma.table.deleteMany({ where: { projectId: { in: createdProjectIds } } }).catch(() => {})
    await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } })
  }
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
  }
})

describe('creating a trigger', () => {
  it('refuses the cloud metadata service with the guard\'s reason', async () => {
    await expect(
      createTrigger(projectId, {
        name: 'exfil',
        sourceTable: 'orders',
        event: 'insert',
        actionType: 'webhook',
        webhookUrl: 'http://169.254.169.254/latest/meta-data/',
      })
    ).rejects.toThrow(/blocked|not allowed|private|metadata/i)
    expect(await prisma.appTrigger.count({ where: { projectId } })).toBe(0)
  })

  it('refuses loopback', async () => {
    await expect(
      createTrigger(projectId, {
        name: 'loopback',
        sourceTable: 'orders',
        event: 'insert',
        actionType: 'webhook',
        webhookUrl: 'http://127.0.0.1:3002/internal',
      })
    ).rejects.toThrow()
    expect(await prisma.appTrigger.count({ where: { projectId } })).toBe(0)
  })

  it('accepts a public https destination', async () => {
    const t = await createTrigger(projectId, {
      name: 'ok-hook',
      sourceTable: 'orders',
      event: 'insert',
      actionType: 'webhook',
      webhookUrl: 'https://example.com/hooks/orders',
    })
    expect(t.id).toBeTruthy()
  })
})

describe('delivery', () => {
  it('goes through safeFetch with the webhook egress scope; raw fetch is never used', async () => {
    guardCalls.length = 0
    nextResponse = { ok: true, status: 200, text: '' }
    const fetchSpy = jest.spyOn(global, 'fetch' as any)

    await fireTriggers(projectId, { type: 'insert', table: 'orders', data: { id: 'row-1', total: 12 } })

    expect(guardCalls).toHaveLength(1)
    expect(guardCalls[0].url).toBe('https://example.com/hooks/orders')
    expect(guardCalls[0].opts.egressScope).toBe('webhook')
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()

    const log = await prisma.triggerDeliveryLog.findFirst({
      where: { trigger: { projectId } },
      orderBy: { createdAt: 'desc' },
    })
    expect(log?.status).toBe('SUCCESS')
  })

  it('caps the stored failure text', async () => {
    guardCalls.length = 0
    nextResponse = { ok: false, status: 503, text: 'x'.repeat(5000) }

    await fireTriggers(projectId, { type: 'insert', table: 'orders', data: { id: 'row-2' } })

    const log = await prisma.triggerDeliveryLog.findFirst({
      where: { trigger: { projectId }, status: { notIn: ['SUCCESS'] } },
      orderBy: { createdAt: 'desc' },
    })
    expect(log).toBeTruthy()
    expect(String(log!.error ?? '').length).toBeLessThanOrEqual(400)
  })
})

describe('capture follows new tables', () => {
  it('CREATE_TABLE through the real executor calls the capture sync', async () => {
    captureCalls.length = 0

    const result = await executeAction(
      {
        action: 'CREATE_TABLE',
        params: { tableName: 'orders', columns: [{ name: 'total', type: 'int' }], confirmed: true },
      } as any,
      projectId
    )

    expect(result.success).toBe(true)
    expect(captureCalls).toContain(projectId)
  })
})

/**
 * A WEBHOOK TRIGGER WITHOUT A DESTINATION IS REFUSED, NOT CREATED DEAD
 * ====================================================================
 * backend_chat steered webhook requests to create_trigger, whose schema had no
 * webhookUrl field — so the model could not pass one, the executor created the
 * trigger anyway, and answered "✅ … calls your webhook at `undefined`". Every
 * later matching write threw 'webhook trigger requires webhookUrl' and logged
 * a DEAD delivery; nothing was ever delivered.
 *
 * Now the schema declares webhookUrl, the executor refuses a webhook trigger
 * without a usable URL at creation (where the caller can still fix it), and
 * the prompt's capability map points "send a webhook to <url>" at the real
 * webhook tools. This drives the real tool dispatch against a real database.
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { BRAIN_TOOLS, dispatchTool } from '@/lib/ai/brain/tools'

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

beforeAll(async () => {
  assertSafeTestDatabase()
  ownerId = (
    await prisma.user.create({
      data: { email: `wh-trigger-${randomUUID()}@test.invalid`, name: 'Webhook Trigger Test' },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: `wh-trigger-${randomUUID().slice(0, 8)}`, userId: ownerId },
      select: { id: true },
    })
  ).id
}, 120_000)

afterAll(async () => {
  await prisma.appTrigger.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
})

describe('the tool can carry the destination at all', () => {
  it('create_trigger declares webhookUrl, so the model can pass one', () => {
    const tool = BRAIN_TOOLS.find((t: any) => t.function?.name === 'create_trigger' || t.name === 'create_trigger') as any
    const params = tool?.function?.parameters ?? tool?.parameters
    expect(params?.properties?.webhookUrl).toBeDefined()
  })
})

describe('creation refuses what delivery could never serve', () => {
  it('kind webhook without a URL is refused with the reason, and no trigger row exists', async () => {
    const res: any = await dispatchTool(
      'create_trigger',
      { tableName: 'orders', on: 'insert', kind: 'webhook' },
      { projectId, userId: ownerId },
    )
    const ok = res.ok ?? res.success
    expect(ok).toBe(false)
    expect(JSON.stringify(res)).toContain('webhookUrl')
    expect(JSON.stringify(res)).not.toContain('undefined')
    const rows = await prisma.appTrigger.findMany({ where: { projectId } })
    expect(rows).toHaveLength(0)
  }, 60_000)

  it('with a URL the trigger is created carrying it', async () => {
    const res: any = await dispatchTool(
      'create_trigger',
      { tableName: 'orders', on: 'insert', kind: 'webhook', webhookUrl: 'https://hooks.acme.example/orders' },
      { projectId, userId: ownerId },
    )
    const ok = res.ok ?? res.success
    expect(ok).toBe(true)
    const row = await prisma.appTrigger.findFirst({ where: { projectId, actionType: 'webhook' } })
    expect(row?.webhookUrl).toBe('https://hooks.acme.example/orders')
  }, 60_000)
})

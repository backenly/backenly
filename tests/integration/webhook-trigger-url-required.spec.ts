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
 *
 * The URL must be https:// (#235), and the dispatcher refuses one that is not
 * before the call is announced or anything is stored; the executor refuses the
 * same for a caller that reaches it directly. list_triggers names the URL each
 * webhook trigger posts to, and asking again with a different URL is refused
 * instead of answered "already exists — nothing to do", which kept the old
 * destination, or none.
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { BRAIN_TOOLS, dispatchTool } from '@/lib/ai/brain/tools'
import { executeAction } from '@/lib/ai/minimal-executor'

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

/** create_trigger as the brain and MCP dispatch it, and the progress the caller was shown. */
async function create(args: Record<string, unknown>) {
  const events: string[] = []
  const res = await dispatchTool('create_trigger', args, {
    projectId,
    userId: ownerId,
    onToolEvent: (e) => events.push(e.phase),
  })
  return { res, events }
}

const stored = () =>
  prisma.appTrigger.findMany({ where: { projectId }, select: { name: true, webhookUrl: true } })

const invoices = { tableName: 'invoices', on: 'insert', kind: 'webhook' }

describe('the destination is checked before anything is stored (#235)', () => {
  beforeEach(async () => {
    await prisma.appTrigger.deleteMany({ where: { projectId } })
  })

  it('kind webhook without a URL is refused before the call is announced', async () => {
    const { res, events } = await create(invoices)
    expect(res).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' })
    expect(res.summary).toContain('webhookUrl')
    // Refused before dispatch: the caller never saw "Adding insert trigger on invoices".
    expect(events).toEqual([])
    expect(await stored()).toEqual([])
  }, 60_000)

  it('an http:// URL is refused: every matching row would be posted in the clear', async () => {
    const { res, events } = await create({ ...invoices, webhookUrl: 'http://hooks.acme.example/invoices' })
    expect(res).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' })
    expect(res.summary).toContain('https://')
    expect(events).toEqual([])
    expect(await stored()).toEqual([])
  }, 60_000)

  it('the executor refuses the same for a caller that reaches it without the dispatcher', async () => {
    for (const webhookUrl of [undefined, 'http://hooks.acme.example/invoices']) {
      const res = await executeAction(
        {
          action: 'CREATE_TRIGGER',
          params: { name: 'webhook_on_insert_invoices', sourceTable: 'invoices', event: 'insert', actionType: 'webhook', webhookUrl },
        } as any,
        projectId, undefined, 0, undefined, false,
      )
      expect(res.success).toBe(false)
      expect(res.message).toContain('https://')
    }
    expect(await stored()).toEqual([])
  }, 60_000)

  it('a destination the outbound guard refuses is refused with its reason, and nothing is stored', async () => {
    const { res } = await create({ ...invoices, webhookUrl: 'https://169.254.169.254/latest/meta-data/' })
    expect(res.ok).toBe(false)
    expect(res.summary).toMatch(/link-local/)
    expect(await stored()).toEqual([])
  }, 60_000)
})

describe('a webhook trigger says where it posts (#235)', () => {
  beforeEach(async () => {
    await prisma.appTrigger.deleteMany({ where: { projectId } })
  })

  it('list_triggers names the URL the trigger posts to', async () => {
    const { res } = await create({ ...invoices, webhookUrl: 'https://hooks.acme.example/invoices' })
    expect(res.ok).toBe(true)

    const listed = await dispatchTool('list_triggers', {}, { projectId, userId: ownerId })
    expect(listed.ok).toBe(true)
    expect(listed.summary).toContain('webhook_on_insert_invoices')
    expect(listed.summary).toContain('https://hooks.acme.example/invoices')
  }, 60_000)

  it('asking again with a different URL is refused, not answered "nothing to do"', async () => {
    await create({ ...invoices, webhookUrl: 'https://hooks.acme.example/invoices' })

    const again = await create({ ...invoices, webhookUrl: 'https://hooks.other.example/invoices' })
    expect(again.res).toMatchObject({ ok: false, code: 'TRIGGER_CONFLICT' })
    expect(again.res.summary).toContain('https://hooks.acme.example/invoices')
    expect(again.res.summary).toContain('Nothing was changed')
    expect(await stored()).toEqual([{ name: 'webhook_on_insert_invoices', webhookUrl: 'https://hooks.acme.example/invoices' }])

    // The same request again stays the no-op a re-run relies on.
    const same = await create({ ...invoices, webhookUrl: 'https://hooks.acme.example/invoices' })
    expect(same.res.ok).toBe(true)
    expect(await stored()).toHaveLength(1)
  }, 60_000)

  it('a trigger stored without a URL reads as delivering nothing, and asking again does not pass for setting one', async () => {
    // As a trigger created before the URL was required is stored.
    await prisma.appTrigger.create({
      data: { projectId, name: 'webhook_on_insert_invoices', sourceTable: 'invoices', event: 'insert', actionType: 'webhook' },
    })

    const listed = await dispatchTool('list_triggers', {}, { projectId, userId: ownerId })
    expect(listed.summary).toMatch(/webhook_on_insert_invoices.*no URL/)

    const again = await create({ ...invoices, webhookUrl: 'https://hooks.acme.example/invoices' })
    expect(again.res).toMatchObject({ ok: false, code: 'TRIGGER_CONFLICT' })
    expect(again.res.summary).toContain('calls no URL')
    expect(await stored()).toEqual([{ name: 'webhook_on_insert_invoices', webhookUrl: null }])
  }, 60_000)
})

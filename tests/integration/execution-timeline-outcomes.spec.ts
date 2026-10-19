/**
 * WHAT AN ACTION LEAVES IN THE EXECUTION TIMELINE AND OPERATIONAL MEMORY
 * ======================================================================
 *
 * The execution timeline records how an action went: its status, timing,
 * retries and, for a failure, its error. It is not a copy of what the action
 * handed back. Against a real database, for a home-region project (whose
 * records keep text):
 *
 *   creating and rotating an API key through executeAction shows the key to
 *   the caller, and no timeline column holds it;
 *   a failure keeps its error with credential shapes withheld, as do a thrown
 *   error, the retry history and stored arguments;
 *   operational memory keeps the request and the result with credentials
 *   withheld.
 *
 * Values are compared by the presence of the exact string; failures name them
 * by a short sha256 prefix only.
 */

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { executeAction } from '@/lib/ai/minimal-executor'
import { trackAction } from '@/lib/ai/execution-timeline'
import { recordBackendExecutionMemory, recordToolExecutionMemory } from '@/lib/operational-memory/ledger'

let ownerId: string
let projectId: string

const hex = (n: number) => crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n)
const fingerprint = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12)

/** Whether any of `values` appears anywhere in `text`, by fingerprint. */
function holds(text: string, values: string[]): string[] {
  return values.filter((v) => text.includes(v)).map(fingerprint)
}

/** Everything the project's timeline rows store, once every entry has closed. */
async function timelineText(): Promise<string> {
  const until = Date.now() + 5_000
  for (;;) {
    const rows = await prisma.executionTimelineEntry.findMany({ where: { projectId } })
    if (rows.every((r) => r.status !== 'pending') || Date.now() > until) return JSON.stringify(rows)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function latestEntry(actionType: string) {
  await timelineText()
  return prisma.executionTimelineEntry.findFirstOrThrow({ where: { projectId, actionType }, orderBy: { startedAt: 'desc' } })
}

const run = (action: string, params: Record<string, unknown>) =>
  executeAction({ action, params } as any, projectId, undefined, 0, undefined, false)

beforeAll(async () => {
  ownerId = (await prisma.user.create({
    data: { email: `timeline-outcomes-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'x', name: 'Timeline Suite' },
    select: { id: true },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'timeline-outcomes', userId: ownerId }, select: { id: true } })).id
}, 120_000)

afterAll(async () => {
  await prisma.executionTimelineEntry.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('a key an action shows once', () => {
  it('is shown to the caller when created, and no timeline column keeps it', async () => {
    const out = await run('CREATE_KEY', { description: 'timeline check' })
    expect(out.success).toBe(true)
    const key = String((out.data as any).apiKey)
    expect(key.length).toBeGreaterThan(30)
    expect(holds(out.message ?? '', [key])).toEqual([fingerprint(key)])

    expect(holds(await timelineText(), [key])).toEqual([])
    expect(await latestEntry('CREATE_KEY')).toMatchObject({ status: 'success', errorMessage: null })
  }, 60_000)

  it('is shown to the caller when rotated, and no timeline column keeps the old or the new one', async () => {
    const created = await run('CREATE_KEY', { description: 'to rotate' })
    const oldKey = String((created.data as any).apiKey)
    const out = await run('ROTATE_KEY', { keyId: (created.data as any).keyId, confirmed: true })
    expect(out.success).toBe(true)
    const newKey = String((out.data as any).newKey)
    expect(newKey.length).toBeGreaterThan(30)
    expect(holds(out.message ?? '', [newKey])).toEqual([fingerprint(newKey)])

    expect(holds(await timelineText(), [oldKey, newKey])).toEqual([])
    expect(await latestEntry('ROTATE_KEY')).toMatchObject({ status: 'success', errorMessage: null })
  }, 60_000)
})

describe('a failure', () => {
  it('keeps its error with credential shapes withheld, in the message and the retry history', async () => {
    const secrets = [`proj_live_${hex(64)}`, `sk_live_${hex(40)}`, `whsec_${hex(32)}`, `bk_admin_${hex(32)}`]
    const password = `pw${hex(20)}`
    const error = `Refused ${secrets[0]} and ${secrets[2]}; could not reach postgres://app:${password}@db.internal/app`
    const out = await trackAction(projectId, `run-${hex(8)}`, { action: 'TIMELINE_FAIL', params: {} }, async () => ({ success: false, error }), {
      retryHistory: [{
        attempt: 1, errorMessage: `first try with ${secrets[1]} and ${secrets[3]}`, errorClassification: 'UNKNOWN',
        healingApplied: null, delayMs: 0, timestamp: new Date().toISOString(),
      }],
    })
    expect(out.success).toBe(false)

    expect(holds(await timelineText(), [...secrets, password])).toEqual([])
    const entry = await latestEntry('TIMELINE_FAIL')
    expect(entry.status).toBe('failed')
    expect(entry.errorMessage).toContain('Refused')
    expect(entry.errorMessage).toContain('postgres://app:')
    expect(entry.errorMessage).toContain('@db.internal/app')
  }, 60_000)

  it('thrown, keeps its error with credential shapes withheld', async () => {
    const secret = `mcp_live_${hex(64)}`
    await expect(trackAction(projectId, `run-${hex(8)}`, { action: 'TIMELINE_THROW', params: {} }, async () => {
      throw new Error(`upstream rejected ${secret}`)
    })).rejects.toThrow('upstream rejected')

    expect(holds(await timelineText(), [secret])).toEqual([])
    const entry = await latestEntry('TIMELINE_THROW')
    expect(entry.status).toBe('failed')
    expect(entry.errorMessage).toContain('upstream rejected')
  }, 60_000)

  it('names a credential its own result carries, withheld from its error even when it has no known shape', async () => {
    const token = `tok${hex(40)}`
    await trackAction(projectId, `run-${hex(8)}`, { action: 'TIMELINE_NAMED', params: {} }, async () => ({
      success: false, error: `could not store ${token}`, data: { token },
    }))
    expect(holds(await timelineText(), [token])).toEqual([])
  }, 60_000)
})

describe('stored arguments', () => {
  it('keep their shape, with a secret-named value withheld', async () => {
    const value = `sk_live_${hex(40)}`
    await trackAction(projectId, `run-${hex(8)}`, { action: 'SET_ENV_VAR', params: { key: 'STRIPE_SECRET_KEY', value } }, async () => ({ success: true }))
    expect(holds(await timelineText(), [value])).toEqual([])
    const entry = await latestEntry('SET_ENV_VAR')
    expect((entry.actionParams as any).key).toBe('STRIPE_SECRET_KEY')
  }, 60_000)
})

describe('operational memory', () => {
  async function memoryText(): Promise<string> {
    const [events, receipts] = await Promise.all([
      (prisma as any).backendEvent.findMany({ where: { projectId } }),
      (prisma as any).changeReceipt.findMany({ where: { projectId } }),
    ])
    return JSON.stringify({ events, receipts })
  }

  it('keeps a turn\'s request and result with credentials withheld', async () => {
    const pasted = `sk_live_${hex(40)}`
    const shown = `proj_live_${hex(64)}`
    await recordToolExecutionMemory({
      projectId,
      actorId: ownerId,
      userMessage: `Save STRIPE_SECRET_KEY as ${pasted} and give me a key`,
      tools: ['set_env_var', 'create_api_key'],
      summary: `Saved STRIPE_SECRET_KEY. Your new key: ${shown}`,
      status: 'applied',
    })
    const text = await memoryText()
    expect(text).toContain('STRIPE_SECRET_KEY')
    expect(holds(text, [pasted, shown])).toEqual([])
  }, 60_000)

  it('keeps a change\'s request and parsed intent with credentials withheld', async () => {
    const pasted = `whsec_${hex(32)}`
    await recordBackendExecutionMemory({
      projectId,
      actorId: ownerId,
      userMessage: `Use webhook secret ${pasted}`,
      canonicalIntent: { action: 'SET_ENV_VAR', params: { key: 'STRIPE_WEBHOOK_SECRET', value: pasted } },
      changes: [],
    } as any)
    expect(holds(await memoryText(), [pasted])).toEqual([])
  }, 60_000)
})

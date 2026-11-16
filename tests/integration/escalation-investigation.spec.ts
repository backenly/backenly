/**
 * Escalated findings get a deterministic investigation first, then, when it
 * cannot conclude, the model investigator, end to end against a real Postgres.
 *
 * The probes are real (they read this project's catalog); the model is
 * scripted. Spend reservations use the gateway's in-memory ledger.
 */

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { AiError, setProviderForTests } from '@/lib/ai/llm'
import { scriptedMessage, scriptedProvider } from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setSpendLedgerForTests } from '@/lib/ai/llm/spend'
import { diagnoseEscalatedFindings } from '@/lib/autonomy/escalation-diagnosis'

let ownerId: string
let projectId: string
let schema: string

async function finding(details: Record<string, unknown> = { tableName: 'orders', column: 'customer_id' }) {
  return prisma.healthFinding.create({
    data: { projectId, type: 'missing_fk', severity: 'warning', status: 'pending_approval', details },
  })
}
const details = async (id: string) =>
  ((await prisma.healthFinding.findUnique({ where: { id } }))!.details ?? {}) as Record<string, any>

const answer = (over: Record<string, unknown> = {}) =>
  scriptedMessage({
    text: JSON.stringify({
      verdict: 'explained',
      rootCause: 'orders.customer_id is a reference column with no constraint behind it.',
      evidenceRefs: ['e1', 'finding'],
      ruledOut: ['orders is missing'],
      recommendation: 'Add a foreign key from orders.customer_id.',
      proposedAction: null,
      riskNote: 'Orphan rows would block the constraint.',
      namedTables: ['orders'],
      namedColumns: ['orders.customer_id'],
      ...over,
    }),
  })

beforeAll(async () => {
  ownerId = (await prisma.user.create({
    data: { email: `investigate-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'inv' },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'escalation-investigation', userId: ownerId } })).id
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "${schema}"."orders" (id serial PRIMARY KEY, customer_id uuid, total numeric)`)
}, 60_000)

beforeEach(async () => {
  setSpendLedgerForTests(memorySpendLedger())
  await prisma.healthFinding.deleteMany({ where: { projectId } })
  await prisma.auditLog.deleteMany({ where: { projectId } })
})
afterEach(() => {
  setProviderForTests(null)
  setSpendLedgerForTests(null)
})

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('investigating an escalated finding', () => {
  it('runs real probes, keeps a checked hypothesis labelled as one, and does not repeat it', async () => {
    const f = await finding()
    const provider = scriptedProvider([
      scriptedMessage({ toolUse: [{ id: 't1', name: 'run_probe', input: { probe: 'table_exists', table: 'orders' } }] }),
      answer(),
    ])
    setProviderForTests(provider)

    expect(await diagnoseEscalatedFindings(projectId)).toBe(1)

    const d = await details(f.id)
    expect(d.diagnosis).toMatchObject({
      provenance: 'ai_hypothesis',
      verdict: 'explained',
      confidence: 'medium',
      validation: { ok: true, problems: [] },
      evidenceRefs: ['e1', 'finding'],
    })
    // The probe really ran against this project's catalog.
    expect(d.diagnosis.evidence[0]).toMatchObject({ id: 'e1', tool: 'probe:table_exists' })
    expect(d.diagnosis.evidence[0].outcome).toBeTruthy()
    // Never labelled as the deterministic investigation.
    expect(d.diagnosis.model).not.toBe('deterministic-investigation')
    expect(await prisma.auditLog.count({ where: { projectId, action: 'AUTONOMY_INVESTIGATION' } })).toBe(1)

    // Same evidence on the next tick: nothing more is asked of the model.
    expect(await diagnoseEscalatedFindings(projectId)).toBe(0)
    expect(provider.calls).toHaveLength(2)
  }, 60_000)

  it('keeps an answer that names what does not exist, but only as uncertain', async () => {
    const f = await finding()
    setProviderForTests(scriptedProvider([answer({ evidenceRefs: ['e7'], namedTables: ['customers'] })]))
    await diagnoseEscalatedFindings(projectId)
    const d = await details(f.id)
    expect(d.diagnosis).toMatchObject({ verdict: 'uncertain', confidence: 'low', validation: { ok: false } })
    expect(d.diagnosis.validation.problems).toContain('names table "customers", which does not exist')
  }, 60_000)

  // Production QA (2026-11-16): the card for a guessed rule recommended
  // "Approve the pending finding" while its buttons were "Keep it" and
  // "Remove it", and quoted the rule's code name.
  it('tells the investigator the card’s buttons, and the rule in words', async () => {
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "${schema}"."reviews" (id serial PRIMARY KEY, name text UNIQUE)`)
    await prisma.healthFinding.create({
      data: {
        projectId,
        type: 'guessed_constraint',
        severity: 'warning',
        status: 'pending_approval',
        details: { tableName: 'reviews', columnName: 'name', constraintName: 'reviews_name_key', rule: 'unique_by_name', evidence: 'unrecorded', definition: 'UNIQUE (name)' },
      },
    })
    const provider = scriptedProvider([answer({ evidenceRefs: ['finding'], namedTables: ['reviews'], namedColumns: ['reviews.name'] })])
    setProviderForTests(provider)
    await diagnoseEscalatedFindings(projectId)
    const brief = JSON.stringify(provider.calls[0].params.messages[0])
    expect(brief).toContain('buttons: \\"Remove it\\" or \\"Keep it\\"')
    expect(brief).not.toContain('unique_by_name')
  }, 60_000)

  it('backs off after a failed attempt instead of retrying every tick', async () => {
    const f = await finding()
    const provider = scriptedProvider([new AiError('timeout', 'slow', { consumption: 'unknown' })])
    setProviderForTests(provider)
    await diagnoseEscalatedFindings(projectId)
    const d = await details(f.id)
    expect(d.diagnosis).toBeUndefined()
    expect(d.investigation).toMatchObject({ attempts: 1, lastError: 'timeout' })
    expect(Date.parse(d.investigation.nextAt) - Date.now()).toBeGreaterThan(9 * 60_000)

    await diagnoseEscalatedFindings(projectId)
    expect(provider.calls).toHaveLength(1)
  }, 60_000)

  it('does not count an attempt while no model can be called at all', async () => {
    const f = await finding()
    setProviderForTests(scriptedProvider([new AiError('spend_limit', 'budget used', { consumption: 'none' })]))
    await diagnoseEscalatedFindings(projectId)
    expect((await details(f.id)).investigation).toMatchObject({ attempts: 0, lastError: 'spend_limit' })
  }, 60_000)
})

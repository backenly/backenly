/**
 * A FUNCTION THAT KEEPS FAILING REACHES A PERSON, ONE ROW PER FUNCTION
 * ====================================================================
 * `functions_keep_working` is notify_only, and the per-minute loop persists only
 * what it would repair on its own. Without the observer running the probe, a
 * failing function was detected every minute and recorded nowhere: Overview's
 * "broken guarantees" counts finding rows, so it stayed at 0.
 *
 * The other half: the reapers match a finding to its gap by gapIdentity, which
 * located a function finding by its trigger table. Two functions on `orders`
 * shared one identity, so while one kept failing, the other's finding could
 * never be withdrawn after it recovered.
 *
 * Real PostgreSQL and the real observer.
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'
import { runObserverForProject } from '@/lib/services/workspace-observer'
import { detectFailingFunctions } from '@/lib/autonomy/function-failures'
import { gapIdentity, type DesiredStateReport } from '@/lib/autonomy/desired-state'
import { reapInvariantFindings } from '@/lib/core/finding-reaper'

const prisma = new PrismaClient()
const userId = randomUUID()
const projectId = randomUUID()
const schema = `workspace_${projectId}`
const raw = (sql: string) => prisma.$executeRawUnsafe(sql)
const fns: Record<string, string> = {}
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000)

async function failingFunction(name: string) {
  const fn = await prisma.aiFunction.create({
    data: {
      projectId, name, description: `${name} (test)`, generatedCode: 'return null', codeOrigin: 'agent',
      triggerType: 'on_db_update', triggerTable: 'orders', status: 'active',
    },
  })
  fns[name] = fn.id
  await run(fn.id, false, hoursAgo(3))
  await run(fn.id, false, hoursAgo(2))
  await run(fn.id, false, hoursAgo(1))
}

const run = (functionId: string, success: boolean, createdAt: Date) =>
  prisma.aiFunctionLog.create({
    data: {
      functionId, projectId, success, logs: [], durationMs: 9, triggerType: 'on_db_update', createdAt,
      error: success ? null : 'Error: no email provider connected',
    },
  })

const openFor = (name: string) =>
  prisma.healthFinding.findMany({
    where: {
      projectId, type: 'function_failing', status: { in: ['open', 'pending_approval'] },
      details: { path: ['functionId'], equals: fns[name] },
    },
  })

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email: `fn-review+${userId.slice(0, 8)}@backenly.test`, name: 'fn', password: 'x' } })
  await prisma.project.create({ data: { id: projectId, name: 'failing-functions-review', userId, jwtSecret: 'a'.repeat(64) } })
  // A registered table is what makes a project watchable by the observer.
  await prisma.table.create({ data: { name: 'orders', projectId } })
  await raw(`CREATE SCHEMA "${schema}"`)
  await raw(`CREATE TABLE "${schema}".orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text)`)
  // Two functions on the same table, both failing on every run.
  await failingFunction('notify-shipping')
  await failingFunction('update-stock')
}, 60_000)

afterAll(async () => {
  await raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.healthFinding.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.aiFunctionLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.aiFunction.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.table.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
  await prisma.$disconnect()
}, 60_000)

describe('a failing function', () => {
  test('the observer records it, waiting on a person, one row per function', async () => {
    await runObserverForProject(projectId)
    const shipping = await openFor('notify-shipping')
    const stock = await openFor('update-stock')
    expect(shipping).toHaveLength(1)
    expect(stock).toHaveLength(1)
    expect(shipping[0].status).toBe('pending_approval')
    expect((shipping[0].details as any).functionName).toBe('notify-shipping')
  }, 120_000)

  test('a second scan keeps one row for each', async () => {
    await runObserverForProject(projectId)
    expect(await openFor('notify-shipping')).toHaveLength(1)
    expect(await openFor('update-stock')).toHaveLength(1)
  }, 120_000)

  test('two functions on one table are two gaps', () => {
    const at = (name: string) => gapIdentity('function_failing', { functionId: fns[name], tableName: 'orders' })
    expect(at('notify-shipping')).not.toBe(at('update-stock'))
  })

  test('one that recovers is withdrawn, the one still failing is kept', async () => {
    await run(fns['notify-shipping'], true, new Date())
    // The reaper as the observer runs it, given exactly what the probe sees now,
    // so no other guarantee's probe can decide the outcome.
    const violations = (await detectFailingFunctions(projectId)).map((f) => ({ type: f.type, details: f.details }))
    expect(violations.map((v) => v.details.functionName)).toEqual(['update-stock'])
    await reapInvariantFindings(projectId, { errors: [], violations } as unknown as DesiredStateReport)
    expect(await openFor('notify-shipping')).toHaveLength(0)
    expect(await openFor('update-stock')).toHaveLength(1)
  }, 120_000)
})

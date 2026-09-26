/**
 * What a sandbox function logs is kept, after a success and after a failure.
 *
 * The worker sends a run's log lines in the message that ends it, `done` or
 * `error`. The parent resolved with its own list, filled only by per-line
 * messages the worker never sends, and rejected with a bare Error, so every
 * sandbox run was recorded with no log lines. After a failure, those lines are
 * what an agent reads through functions { action: "logs" } to find out why.
 *
 * Runs the real executor, worker thread and log table.
 */

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { executeAiFunction } from '@/lib/services/ai-functions/executor'

let userId: string
let projectId: string

async function sandboxFunction(name: string, code: string): Promise<string> {
  const fn = await prisma.aiFunction.create({
    data: { projectId, name, description: name, generatedCode: code, triggerType: 'manual', status: 'active' },
  })
  return fn.id
}

beforeAll(async () => {
  userId = (await prisma.user.create({
    data: { email: `sandbox-logs-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'logs' },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'sandbox-logs', userId } })).id
}, 60_000)

afterAll(async () => {
  await prisma.project.deleteMany({ where: { userId } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
}, 60_000)

it('keeps the lines a successful run logged', async () => {
  const id = await sandboxFunction('logs-then-returns', `
    ctx.log('starting', { n: 1 })
    console.log('second line')
    return { ok: true }
  `)
  const result = await executeAiFunction(id, projectId, { type: 'manual', data: {} }, { selfHeal: false })
  expect(result.success).toBe(true)
  expect(result.logs).toEqual(['starting {"n":1}', 'second line'])

  const row = await prisma.aiFunctionLog.findFirst({ where: { functionId: id }, orderBy: { createdAt: 'desc' } })
  expect(row).toMatchObject({ success: true, logs: ['starting {"n":1}', 'second line'] })
}, 60_000)

it('keeps the lines a failed run logged before it failed, with the error', async () => {
  const id = await sandboxFunction('logs-then-throws', `
    ctx.log('before the failure', event.data.step)
    throw new Error('deliberately broken')
  `)
  const result = await executeAiFunction(id, projectId, { type: 'manual', data: { step: 3 } }, { selfHeal: false })
  expect(result.success).toBe(false)
  expect(result.error).toContain('deliberately broken')
  expect(result.logs).toEqual(['before the failure 3'])

  const row = await prisma.aiFunctionLog.findFirst({ where: { functionId: id }, orderBy: { createdAt: 'desc' } })
  expect(row).toMatchObject({ success: false, logs: ['before the failure 3'] })
  expect(row?.error).toContain('deliberately broken')
}, 60_000)

it('records an empty log, not an invented one, when a failed run logged nothing', async () => {
  const id = await sandboxFunction('throws-silently', `throw new Error('no lines first')`)
  const result = await executeAiFunction(id, projectId, { type: 'manual', data: {} }, { selfHeal: false })
  expect(result.success).toBe(false)
  expect(result.logs).toEqual([])
}, 60_000)

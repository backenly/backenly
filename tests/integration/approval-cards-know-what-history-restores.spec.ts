/**
 * An approval card says a deletion can be undone when History can restore it.
 *
 * describeApproval (lib/mcp/approval-describe.ts) writes the "Restore point
 * available" or "Not auto-reversible" a Review Queue card shows. Deleting a
 * function, a schedule or a trigger is a governed change that records the
 * thing whole, and restoring the change puts it back
 * (lib/changes/resources/functions.ts, webhooks.ts), yet the card for "Delete
 * the function qa-json" said "Not auto-reversible" while the result said
 * History could restore it (production QA, 2026-11-16). A trigger that signs
 * its deliveries is the exception: its secret is not kept.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { describeApproval } from '@/lib/mcp/approval-describe'

const engineMode = process.env.ENGINE_MODE
let userId: string
let projectId: string
let plainTrigger: string
let signingTrigger: string

beforeAll(async () => {
  // The change ledger records only when the engine runs for real (lib/changes/ledger.ts).
  process.env.ENGINE_MODE = 'runtime'
  userId = (await prisma.user.create({ data: { email: `approval-undo-${Date.now()}@example.test`, password: 'x', name: 'undo' } })).id
  projectId = randomUUID()
  await prisma.project.create({ data: { id: projectId, name: 'approval-undo', userId } as any })
  const trigger = (fields: Record<string, unknown>) =>
    prisma.appTrigger.create({ data: { projectId, name: 'notify-on-order', sourceTable: 'orders', event: 'insert', actionType: 'webhook', webhookUrl: 'https://hooks.example.com/orders', ...fields } as any })
  plainTrigger = (await trigger({})).id
  signingTrigger = (await trigger({ name: 'signed-notify', webhookSecret: 'whsec_' + 'x'.repeat(24) })).id
})

afterAll(async () => {
  process.env.ENGINE_MODE = engineMode
  await prisma.appTrigger.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
})

describe('the approval card of a deletion', () => {
  test('says a function History can restore can be undone', async () => {
    expect(await describeApproval(projectId, 'delete_ai_function', { name: 'qa-json' })).toMatchObject({ reversible: true })
  })

  test('says a schedule History can restore can be undone', async () => {
    expect(await describeApproval(projectId, 'delete_cron_job', { name: 'nightly-digest' })).toMatchObject({ reversible: true })
  })

  test('says a trigger History can restore can be undone, and one that signs its deliveries cannot', async () => {
    expect(await describeApproval(projectId, 'delete_trigger', { triggerId: plainTrigger })).toMatchObject({ reversible: true })
    expect(await describeApproval(projectId, 'delete_trigger', { triggerId: signingTrigger })).toMatchObject({ reversible: false })
  })

  test('still says what nothing keeps cannot be undone', async () => {
    expect(await describeApproval(projectId, 'delete_env_var', { name: 'STRIPE_KEY' })).toMatchObject({ reversible: false })
    expect(await describeApproval(projectId, 'delete_webhook', { webhookId: randomUUID() })).toMatchObject({ reversible: false })
  })

  test('says nothing can be undone while History records nothing', async () => {
    process.env.BACKENLY_CHANGE_LEDGER = 'off'
    try {
      expect(await describeApproval(projectId, 'delete_ai_function', { name: 'qa-json' })).toMatchObject({ reversible: false })
    } finally {
      delete process.env.BACKENLY_CHANGE_LEDGER
    }
  })
})

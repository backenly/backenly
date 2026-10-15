/**
 * rotate_trigger_secret keeps its advertised contract (medium finding WH-F9).
 *
 * The generated docs said it needs "nothing" (the JSON schema cannot express
 * triggerName-or-triggerId, so required was []) while the executor refused a
 * call with neither; and the domain summary promised the secret in
 * data.secret while the executor buried it in prose. The docs now print a
 * DECLARED alternative, and the secret rides data.secret.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

import { prisma } from '@/lib/db/prisma'
import { executeAction } from '@/lib/ai/minimal-executor'
import { actionRequires } from '@/lib/mcp/domains'

const ROOT = process.cwd()

let ownerId: string
let projectId: string
let triggerId: string

beforeAll(async () => {
  ownerId = (
    await prisma.user.create({
      data: {
        email: `rotate-contract-${crypto.randomBytes(6).toString('hex')}@example.test`,
        password: 'not-a-real-hash',
        name: 'Rotate Contract Suite',
      },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: 'rotate-contract', userId: ownerId },
      select: { id: true },
    })
  ).id
  triggerId = (
    await prisma.appTrigger.create({
      data: {
        projectId,
        name: 'notify-crm',
        sourceTable: 'orders',
        event: 'insert',
        actionType: 'webhook',
        webhookUrl: 'https://receiver.example.test/hook',
        webhookSecret: 'whsec_old',
      },
      select: { id: true },
    })
  ).id
}, 120_000)

afterAll(async () => {
  await prisma.appTrigger.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('WH-F9: the rotate contract is real', () => {
  it('the declared alternative replaces "Needs: nothing" everywhere the docs derive from', () => {
    expect(actionRequires('rotate_webhook_secret')).toEqual(['triggerName or triggerId'])
    expect(actionRequires('block_end_user')).toEqual(['userId or email'])
    const doc = fs.readFileSync(path.join(ROOT, 'public', 'docs', 'agents', 'webhooks.md'), 'utf8')
    expect(doc).toContain('`triggerName or triggerId`')
  })

  it('rotation returns the new secret in data.secret and really rotates the row', async () => {
    const out = await executeAction(
      { action: 'ROTATE_WEBHOOK_SECRET', params: { triggerName: 'notify-crm' } } as any,
      projectId, undefined, 0, undefined, false,
    )
    expect(out.success).toBe(true)
    const secret = (out.data as any).secret
    expect(secret).toMatch(/^whsec_[0-9a-f]{48}$/)
    const row = await prisma.appTrigger.findUnique({ where: { id: triggerId }, select: { webhookSecret: true } })
    expect(row?.webhookSecret).toBe(secret)
    expect(row?.webhookSecret).not.toBe('whsec_old')
  }, 60_000)

  it('a call with neither name nor id still refuses', async () => {
    const out = await executeAction(
      { action: 'ROTATE_WEBHOOK_SECRET', params: {} } as any,
      projectId, undefined, 0, undefined, false,
    )
    expect(out.success).toBe(false)
    expect(out.message).toContain('triggerName or triggerId')
  }, 60_000)
})

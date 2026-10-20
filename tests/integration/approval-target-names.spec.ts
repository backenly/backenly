/**
 * The Review Queue entry for delete_webhook and remove_auth_smtp names what a
 * person would destroy, and names it only from their own project (#224).
 *
 * When the brain's gate stops a destructive call, describeDanger writes the
 * target the Review Queue stores and shows: "Your coding agent wants to run
 * <tool> on <target>". Both tools fell to a default that showed the bare tool
 * name. delete_webhook now looks its webhook up by id, and the project filter on
 * that lookup is all that keeps an entry from showing another project's
 * endpoint URL.
 *
 * Real database: the projects, the webhook and delivery rows, the SMTP settings
 * and the conversation log. Only the model is scripted.
 */

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { setProviderForTests } from '@/lib/ai/llm'
import { scriptedMessage, scriptedProvider } from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setSpendLedgerForTests } from '@/lib/ai/llm/spend'
import { saveSmtpConfig } from '@/lib/email/project-smtp'
import { runBrain, type BrainEvent } from '@/lib/ai/brain/agent'

const SMTP_ENV = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'] as const
const savedSmtpEnv = Object.fromEntries(SMTP_ENV.map((k) => [k, process.env[k]]))

let ownerId = ''
let projectId = ''
let otherOwnerId = ''
let otherProjectId = ''

const classified = scriptedMessage({ text: JSON.stringify({ intent: 'DESTRUCTIVE', confidence: 0.9, reasoning: 'scripted' }) })

/** A brain turn in which the model asks for one call and the gate stops it. */
async function stopped(tool: string, input: Record<string, unknown>) {
  const provider = scriptedProvider([
    classified,
    scriptedMessage({ toolUse: [{ id: 'toolu_gated', name: tool, input }] }),
    scriptedMessage({ toolUse: [{ id: 'toolu_finish', name: 'finish', input: { summary: 'Queued for approval.' } }] }),
  ])
  setProviderForTests(provider)
  const events: BrainEvent[] = []
  const result = await runBrain({ projectId, userId: ownerId, message: `run ${tool}` }, (e) => events.push(e))
  expect(result.blockedCalls).toHaveLength(1)
  const call = result.blockedCalls![0]
  expect(call).toMatchObject({ tool, args: input })
  // Everything the model was sent this turn, the stopped call's result included.
  const toldModel = JSON.stringify(provider.calls.map((c) => c.params))
  return { call, result, events, toldModel }
}

async function seedWebhook(project: string, targetUrl: string): Promise<string> {
  const row = await prisma.webhook.create({
    data: { projectId: project, eventType: 'row.inserted', targetUrl, secret: `whsec_${crypto.randomBytes(8).toString('hex')}` },
    select: { id: true },
  })
  return row.id
}

/** This project's SMTP settings, saved the way the Auth page saves them. */
async function seedSmtpSettings() {
  await saveSmtpConfig(projectId, {
    host: 'smtp.example.test',
    port: 587,
    username: 'mailer',
    password: 'not-a-real-password',
    fromAddress: 'auth@example.test',
    enabled: true,
  })
  return prisma.projectEmailConfig.findUnique({ where: { projectId } })
}

beforeAll(async () => {
  const user = (label: string) =>
    prisma.user.create({ data: { email: `${label}-${crypto.randomUUID()}@test.invalid`, name: label }, select: { id: true } })
  ownerId = (await user('approval-target')).id
  otherOwnerId = (await user('approval-target-other')).id
  projectId = (await prisma.project.create({ data: { name: 'approval-target', userId: ownerId }, select: { id: true } })).id
  otherProjectId = (await prisma.project.create({ data: { name: 'approval-target-other', userId: otherOwnerId }, select: { id: true } })).id
  // The brain reads the workspace while it builds a turn's context.
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${projectId}"`)
}, 60_000)

beforeEach(async () => {
  setSpendLedgerForTests(memorySpendLedger())
  await prisma.conversationMessage.deleteMany({ where: { projectId } })
})

afterEach(() => {
  setProviderForTests(null)
  setSpendLedgerForTests(null)
  for (const k of SMTP_ENV) {
    if (savedSmtpEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedSmtpEnv[k]
  }
})

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
  await prisma.webhook.deleteMany({ where: { projectId: { in: [projectId, otherProjectId] } } }).catch(() => {})
  await prisma.projectEmailConfig.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.conversationMessage.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.aiUsage.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId: { in: [projectId, otherProjectId] } } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: { in: [projectId, otherProjectId] } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherOwnerId] } } }).catch(() => {})
}, 60_000)

describe('the entry for delete_webhook', () => {
  it('names the webhook with its event and target URL, and the gate deletes nothing', async () => {
    const url = `https://hooks.example.test/orders/${crypto.randomUUID()}`
    const webhookId = await seedWebhook(projectId, url)
    await prisma.webhookLog.create({ data: { webhookId, eventType: 'row.inserted', signature: 'sha256=test' } })

    const { call } = await stopped('delete_webhook', { webhookId })

    expect(call.target).toBe(`the webhook \`${webhookId}\` (row.inserted → ${url}) and its delivery history`)
    expect(call.reversible).toBe(false)
    expect(await prisma.webhook.count({ where: { id: webhookId } })).toBe(1)
    expect(await prisma.webhookLog.count({ where: { webhookId } })).toBe(1)
  }, 60_000)

  it('says a webhook of another project is not in this one, and never shows its URL', async () => {
    const theirUrl = `https://hooks.example.test/theirs/${crypto.randomUUID()}`
    const theirs = await seedWebhook(otherProjectId, theirUrl)

    const { call, result, events, toldModel } = await stopped('delete_webhook', { webhookId: theirs })

    expect(call.target).toBe(`the webhook \`${theirs}\` (no such webhook in this project)`)
    expect(toldModel).toContain('(no such webhook in this project)')
    for (const seen of [call.target, toldModel, JSON.stringify(result), JSON.stringify(events)]) {
      expect(seen).not.toContain(theirUrl)
    }
    expect(await prisma.webhook.count({ where: { id: theirs } })).toBe(1)
  }, 60_000)
})

describe('the entry for remove_auth_smtp', () => {
  it("says auth email then goes out through the deployment's SMTP, when it has one, and removes nothing", async () => {
    const before = await seedSmtpSettings()
    process.env.SMTP_HOST = 'smtp.deployment.test'
    process.env.SMTP_USER = 'deployment'
    process.env.SMTP_PASS = 'not-a-real-password'

    const { call } = await stopped('remove_auth_smtp', {})

    expect(call.target).toBe(
      "this project's SMTP settings (verification, password-reset and magic-link emails then go out through the deployment's SMTP instead)",
    )
    expect(call.reversible).toBe(false)
    expect(await prisma.projectEmailConfig.findUnique({ where: { projectId } })).toEqual(before)
  }, 60_000)

  it('says auth email then stops when the deployment has no SMTP, and removes nothing', async () => {
    const before = await seedSmtpSettings()
    for (const k of SMTP_ENV) delete process.env[k]

    const { call } = await stopped('remove_auth_smtp', {})

    expect(call.target).toBe(
      "this project's SMTP settings (verification, password-reset and magic-link emails then stop: this deployment has no SMTP to fall back to)",
    )
    expect(call.reversible).toBe(false)
    expect(await prisma.projectEmailConfig.findUnique({ where: { projectId } })).toEqual(before)
  }, 60_000)
})
